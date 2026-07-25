import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Mail, Plug, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { PreviewBadge } from '../ui/PreviewBadge';
import { LastSynced } from '../ui/LastSynced';
import { useToast } from '../../contexts/ToastContext';
import {
  beginConnect,
  disconnect,
  needsReconnect,
  readStatus,
  type IntegrationStatus,
  type Provider,
} from '../../lib/integrations/status';
import { isMock } from '../../lib/integrations/config';

/**
 * One place for everything that reaches outside the app: the card link,
 * Calendar, Gmail. Information architecture rather than decoration — before
 * this pass there was one external surface, now there are several, and they
 * belong together instead of scattered through Settings.
 */

const PROVIDER_COPY: Record<Provider, { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; body: string; scope: string }> = {
  calendar: {
    icon: CalendarDays,
    title: 'Google Calendar',
    body: 'Reads upcoming events so briefs arrive before the meeting does.',
    scope: 'calendar.events.readonly',
  },
  gmail: {
    icon: Mail,
    title: 'Gmail',
    body: 'Sends outreach and watches only the threads Cirqle started.',
    scope: 'gmail.send · gmail.metadata',
  },
};

export function ConnectionRow({
  provider,
  uid,
  email,
  onChanged,
}: {
  provider: Provider;
  uid: string;
  email?: string | null;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = PROVIDER_COPY[provider];
  const Icon = copy.icon;

  const load = useCallback(() => {
    readStatus(uid, provider)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [uid, provider]);

  useEffect(load, [load]);

  const handleConnect = async () => {
    setBusy(true);
    try {
      const result = await beginConnect({ uid, provider, email });
      if (result === 'mock') {
        toast(`${copy.title} connected in preview mode.`, 'success');
        load();
        onChanged?.();
      }
      // 'redirecting' navigates away; nothing to do here.
    } catch (error: any) {
      toast(error?.message || 'Could not start the connection.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnect(uid, provider);
      toast(`${copy.title} disconnected.`, 'info');
      load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const stale = status ? needsReconnect(status) : false;

  return (
    <div className="flex flex-wrap items-start gap-4 rounded-card border border-ink/15 bg-white p-4">
      <Icon size={16} className="mt-0.5 shrink-0 text-brand" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-widest">{copy.title}</span>
          {status?.connected && isMock() && <PreviewBadge />}
        </div>

        <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted">{copy.body}</p>

        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted">
          Scope · {copy.scope}
        </p>

        {status?.connected && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <LastSynced at={status.lastSyncedAt} />
            {status.email && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {status.email}
              </span>
            )}
          </div>
        )}

        {stale && (
          <p className="mt-2.5 flex items-start gap-2 font-mono text-[11px] leading-relaxed text-subtle">
            <TriangleAlert size={12} className="mt-0.5 shrink-0 text-brand" />
            Google expires test-mode access after 7 days. Reconnect to keep it running — expected,
            not broken.
          </p>
        )}
      </div>

      <div className="shrink-0">
        {status?.connected ? (
          <div className="flex gap-2">
            {stale && (
              <Button variant="brand" size="sm" onClick={handleConnect} disabled={busy}>
                <RotateCw size={11} className="mr-1.5" />
                Reconnect
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={handleDisconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={handleConnect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConnectionsHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="flex items-center gap-2 font-serif text-2xl font-bold italic">
        <Plug size={16} className="text-brand" />
        Connections
      </h2>
      {isMock() && <PreviewBadge label="Preview mode" title="No Google OAuth client configured — running on sample data. See MANUAL_SETUP.md." />}
    </div>
  );
}
