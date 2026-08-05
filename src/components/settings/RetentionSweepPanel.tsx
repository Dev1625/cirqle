import React, { useRef, useState } from 'react';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
} from 'firebase/auth';
import { Eraser, ShieldCheck } from 'lucide-react';

import { auth } from '../../config/firebase';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { friendlyAuthError } from '../../lib/authSecurity';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface RetentionBucket {
  scanned: number;
  eligible: number;
  deleted: number;
  retained: number;
  missingObservedAt: number;
  providerDisconnected: number;
}

interface RetentionReport extends RetentionBucket {
  dryRun: boolean;
  evaluatedAt: string;
  bySourceType: Record<string, RetentionBucket>;
  hasMore: boolean;
  nextCursor: string | null;
}

const EMPTY_BUCKET: RetentionBucket = {
  scanned: 0,
  eligible: 0,
  deleted: 0,
  retained: 0,
  missingObservedAt: 0,
  providerDisconnected: 0,
};

const SOURCE_LABELS: Record<string, string> = {
  note: 'Notes',
  voice: 'Voice memos',
  meeting: 'Meetings',
  email: 'Email',
  outreach: 'Outreach',
  reply: 'Replies',
  commitment: 'Commitments',
  fact: 'Facts',
  calendar: 'Calendar',
};

function addBucket(left: RetentionBucket, right: Partial<RetentionBucket>) {
  return {
    scanned: left.scanned + Number(right.scanned || 0),
    eligible: left.eligible + Number(right.eligible || 0),
    deleted: left.deleted + Number(right.deleted || 0),
    retained: left.retained + Number(right.retained || 0),
    missingObservedAt:
      left.missingObservedAt + Number(right.missingObservedAt || 0),
    providerDisconnected:
      left.providerDisconnected + Number(right.providerDisconnected || 0),
  };
}

function mergeReport(
  current: RetentionReport | null,
  page: RetentionReport,
): RetentionReport {
  const totals = addBucket(current || EMPTY_BUCKET, page);
  const bySourceType = { ...(current?.bySourceType || {}) };
  for (const [sourceType, bucket] of Object.entries(
    page.bySourceType || {},
  )) {
    bySourceType[sourceType] = addBucket(
      bySourceType[sourceType] || EMPTY_BUCKET,
      bucket,
    );
  }
  return {
    ...totals,
    dryRun: page.dryRun,
    evaluatedAt: page.evaluatedAt,
    bySourceType,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

async function responseError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => ({}));
  const code = String(payload?.error?.code || '');
  const message =
    code === 'recent_login_required'
      ? 'Verify your identity again before applying retention.'
      : code === 'confirmation_required'
        ? 'The retention confirmation did not match.'
        : code === 'unauthorized'
          ? 'Your session expired. Sign in again and retry.'
          : 'The retention service could not complete this pass. It is safe to retry.';
  return Object.assign(new Error(message), { code });
}

async function sweepAllPages({
  dryRun,
  onProgress,
}: {
  dryRun: boolean;
  onProgress: (report: RetentionReport) => void;
}): Promise<RetentionReport> {
  let cursor: string | null = null;
  let report: RetentionReport | null = null;

  // A bounded loop prevents a malformed server response from trapping the UI.
  // Normal accounts complete in one pass; large accounts resume through an
  // opaque cursor without exposing source ids or document paths.
  for (let page = 0; page < 100; page += 1) {
    const response = await authenticatedFetch('/api/account/retention-sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRun,
        ...(cursor ? { cursor } : {}),
        ...(dryRun ? {} : { confirmation: 'APPLY RETENTION' }),
      }),
    });
    if (!response.ok) throw await responseError(response);

    const next = (await response.json()) as RetentionReport;
    report = mergeReport(report, next);
    onProgress(report);
    if (!next.hasMore || !next.nextCursor) return report;
    cursor = next.nextCursor;
  }

  throw new Error(
    'This account needs another retention pass. No extra records were deleted beyond the completed pages.',
  );
}

export function RetentionSweepPanel({
  policyRevision,
}: {
  policyRevision: number;
}) {
  const user = auth.currentUser;
  const [preview, setPreview] = useState<RetentionReport | null>(null);
  const [result, setResult] = useState<RetentionReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const passwordRef = useRef<HTMLInputElement>(null);
  const [previewPolicyRevision, setPreviewPolicyRevision] = useState<
    number | null
  >(null);

  const providerIds = user?.providerData.map((provider) => provider.providerId) || [];
  const usesPassword = providerIds.includes('password');
  const usesGoogle = providerIds.includes('google.com');
  const previewIsCurrent = previewPolicyRevision === policyRevision;

  const previewRetention = async () => {
    setBusy('preview');
    setError('');
    setResult(null);
    setPreview(null);
    try {
      const report = await sweepAllPages({
        dryRun: true,
        onProgress: setPreview,
      });
      setPreviewPolicyRevision(policyRevision);
      setPreview(report);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : 'The retention preview could not be prepared.',
      );
    } finally {
      setBusy(null);
    }
  };

  const reauthenticate = async () => {
    if (!user) throw new Error('Sign in again to continue.');
    if (usesPassword) {
      if (!user.email || !password) {
        throw Object.assign(new Error('Password required.'), {
          code: 'auth/invalid-credential',
        });
      }
      await reauthenticateWithCredential(
        user,
        EmailAuthProvider.credential(user.email, password),
      );
    } else if (usesGoogle) {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
    } else {
      throw Object.assign(new Error('Unsupported sign-in method.'), {
        code: 'auth/operation-not-allowed',
      });
    }
    await user.getIdToken(true);
  };

  const applyRetention = async () => {
    if (!preview || !previewIsCurrent || confirmation !== 'APPLY RETENTION') {
      setError('Preview the current policy and type APPLY RETENTION exactly.');
      return;
    }
    setBusy('apply');
    setError('');
    setResult(null);
    try {
      await reauthenticate();
      const applied = await sweepAllPages({
        dryRun: false,
        onProgress: setResult,
      });
      setResult(applied);
      setPreview(null);
      setPreviewPolicyRevision(null);
      setDialogOpen(false);
      setPassword('');
      setConfirmation('');
    } catch (applyError: any) {
      const isFirebaseError =
        typeof applyError?.code === 'string' &&
        applyError.code.startsWith('auth/');
      setError(
        isFirebaseError
          ? friendlyAuthError(applyError, 'reauthenticate')
          : applyError instanceof Error
            ? applyError.message
            : 'The retention sweep could not finish. It is safe to retry.',
      );
    } finally {
      setBusy(null);
    }
  };

  const sourceRows = Object.entries(
    (result || preview)?.bySourceType || {},
  ).filter(([, bucket]) => bucket.scanned > 0);

  return (
    <section
      className="rounded-card border border-ink/20 bg-white p-5"
      aria-labelledby="retention-sweep-title"
    >
      <div className="flex items-start gap-3">
        <Eraser size={20} className="mt-1 text-brand" aria-hidden="true" />
        <div>
          <h2
            id="retention-sweep-title"
            className="font-serif text-2xl font-bold italic"
          >
            Apply retention.
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
            Preview count-only results first. Cirqle never includes note text,
            record ids, or storage paths in this report, and primary contact
            profiles are never deleted by source retention.
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={previewRetention}
          disabled={Boolean(busy)}
          aria-busy={busy === 'preview'}
        >
          {busy === 'preview' ? 'Checking sources…' : 'Preview retention'}
        </Button>
        {preview && previewIsCurrent && preview.eligible > 0 && (
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setError('');
              setDialogOpen(true);
            }}
            disabled={Boolean(busy)}
          >
            Review {preview.eligible} deletion
            {preview.eligible === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      {(preview || result) && (
        <div
          className="mt-5 rounded-card border border-ink/15 bg-paper/40 p-4"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs">
            <span>Scanned: {(result || preview)?.scanned}</span>
            <span>
              {(result || preview)?.dryRun ? 'Would delete' : 'Deleted'}:{' '}
              {(result || preview)?.dryRun
                ? (result || preview)?.eligible
                : (result || preview)?.deleted}
            </span>
            <span>Retained: {(result || preview)?.retained}</span>
          </div>
          {sourceRows.length > 0 && (
            <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              {sourceRows.map(([sourceType, bucket]) => (
                <li key={sourceType} className="flex justify-between gap-4">
                  <span>{SOURCE_LABELS[sourceType] || sourceType}</span>
                  <span className="font-mono">
                    {(result || preview)?.dryRun
                      ? bucket.eligible
                      : bucket.deleted}{' '}
                    / {bucket.scanned}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result && (
            <p className="mt-3 flex items-center gap-2 text-xs text-emerald-800">
              <ShieldCheck size={14} aria-hidden="true" />
              Retention completed. Re-running is safe and idempotent.
            </p>
          )}
        </div>
      )}

      {!previewIsCurrent && preview && (
        <p className="mt-3 text-xs text-amber-800" role="status">
          The privacy policy changed after this preview. Preview again before
          applying it.
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (busy) return;
          setDialogOpen(false);
          setPassword('');
          setConfirmation('');
        }}
        closeOnBackdrop={!busy}
        title="Verify and apply retention"
        description="Retention permanently removes only the source records identified by your current policy."
        initialFocusRef={usesPassword ? passwordRef : undefined}
        className="max-w-lg bg-white"
      >
        <section className="p-6">
          <h2 className="font-serif text-2xl font-bold italic">
            Apply {preview?.eligible || 0} retention deletion
            {preview?.eligible === 1 ? '' : 's'}?
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            This cannot be undone through the app. Contact profiles remain
            intact. A fresh sign-in is required.
          </p>

          {usesPassword && (
            <div className="mt-5">
              <label
                htmlFor="retention-password"
                className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
              >
                Current password
              </label>
              <Input
                ref={passwordRef}
                id="retention-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}

          <div className="mt-4">
            <label
              htmlFor="retention-confirmation"
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              Type APPLY RETENTION
            </label>
            <Input
              id="retention-confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              onClick={applyRetention}
              disabled={
                Boolean(busy) ||
                confirmation !== 'APPLY RETENTION' ||
                (usesPassword && !password)
              }
              aria-busy={busy === 'apply'}
            >
              {busy === 'apply'
                ? 'Applying retention…'
                : usesGoogle && !usesPassword
                  ? 'Continue with Google'
                  : 'Verify and apply'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={Boolean(busy)}
            >
              Cancel
            </Button>
          </div>
        </section>
      </Dialog>
    </section>
  );
}
