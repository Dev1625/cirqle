import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ShieldCheck, Sparkles } from 'lucide-react';

import { useAuth } from '../contexts/AuthContext';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { Button } from '../components/ui/Button';

/**
 * Consent screen for Cirqle's OAuth authorization server.
 *
 * `/api/oauth/authorize` validates the client and redirect URI, then sends the
 * browser here. Reusing the app's own login means there is no second password
 * surface: whoever is signed in is the person granting access, and the
 * verification gate already applies.
 *
 * The redirect back to the client happens from the browser, so the
 * authorization code is never placed in a Location header the server controls.
 */

const SCOPE_COPY: Record<string, string> = {
  'cirqle.read': 'Read your contacts and their history',
  'cirqle.write': 'Add and update contacts, notes, meetings, and logged emails',
};

export default function OAuthConsent() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const request = useMemo(
    () => ({
      clientId: params.get('client_id') || '',
      clientName: params.get('client_name') || 'An AI client',
      redirectUri: params.get('redirect_uri') || '',
      codeChallenge: params.get('code_challenge') || '',
      codeChallengeMethod: params.get('code_challenge_method') || 'S256',
      scope: params.get('scope') || '',
      state: params.get('state') || '',
      resource: params.get('resource') || '',
    }),
    [params],
  );

  useEffect(() => {
    document.title = 'Connect an AI client — Cirqle';
  }, []);

  const scopes = request.scope.split(/\s+/).filter(Boolean);
  const incomplete =
    !request.clientId || !request.redirectUri || !request.codeChallenge;

  const deny = () => {
    if (!request.redirectUri) return;
    const target = new URL(request.redirectUri);
    target.searchParams.set('error', 'access_denied');
    if (request.state) target.searchParams.set('state', request.state);
    window.location.replace(target.toString());
  };

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await authenticatedFetch('/api/oauth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          code_challenge: request.codeChallenge,
          code_challenge_method: request.codeChallengeMethod,
          scope: request.scope,
          resource: request.resource,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.code) {
        setError(
          payload?.error_description ||
            'Cirqle could not complete the connection. Try again from your AI client.',
        );
        return;
      }

      // The server returns the verified redirect URI rather than trusting the
      // one in this page's query string.
      const target = new URL(payload.redirect_uri || request.redirectUri);
      target.searchParams.set('code', payload.code);
      if (request.state) target.searchParams.set('state', request.state);
      window.location.replace(target.toString());
    } catch {
      setError('Something went wrong. Try again from your AI client.');
    } finally {
      setBusy(false);
    }
  };

  if (incomplete) {
    return (
      <Shell title="This link is incomplete.">
        <p className="font-mono text-xs leading-relaxed text-muted">
          Start the connection from your AI client rather than opening this page
          directly.
        </p>
      </Shell>
    );
  }

  if (!user) {
    const next = `${window.location.pathname}${window.location.search}`;
    return (
      <Shell title="Sign in to continue.">
        <p className="font-mono text-xs leading-relaxed text-muted">
          <strong className="font-bold">{request.clientName}</strong> wants
          access to your Cirqle network. Sign in to decide.
        </p>
        <Link to={`/login?next=${encodeURIComponent(next)}`}>
          <Button variant="brand" size="sm">Sign in</Button>
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="Connect an AI client.">
      <p className="font-mono text-xs leading-relaxed text-muted">
        <strong className="font-bold text-ink">{request.clientName}</strong> is
        asking to connect to your Cirqle network as{' '}
        <strong className="font-bold text-ink">{user.email}</strong>.
      </p>

      <ul className="w-full space-y-2 text-left">
        {scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-2">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
            <span className="font-mono text-xs leading-relaxed">
              {SCOPE_COPY[scope] || scope}
            </span>
          </li>
        ))}
      </ul>

      <p className="font-mono text-[11px] leading-relaxed text-muted">
        It can add and update records. It cannot delete, merge, or archive
        anything. Everything it writes is labelled as AI-written, and you can
        remove all of it from Settings → Privacy &amp; AI.
      </p>

      {error ? (
        <p role="alert" className="font-mono text-xs leading-relaxed text-brand">
          {error}
        </p>
      ) : null}

      <div className="flex w-full items-center justify-center gap-3">
        <Button variant="outline" size="sm" onClick={deny} disabled={busy}>
          Cancel
        </Button>
        <Button variant="brand" size="sm" onClick={approve} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </Shell>
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <main
        className="animate-fade-slide-up flex w-full max-w-sm flex-col items-center gap-4 rounded-card border border-ink/25 bg-white px-8 py-10 text-center shadow-card"
        aria-labelledby="oauth-consent-title"
      >
        <Sparkles size={22} className="text-brand" aria-hidden="true" />
        <h1 id="oauth-consent-title" className="font-serif text-2xl font-bold italic">
          {title}
        </h1>
        {children}
      </main>
    </div>
  );
}
