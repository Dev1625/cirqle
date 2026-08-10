import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { Compass } from 'lucide-react';

import { Button } from '../components/ui/Button';

/**
 * Catch-all for unmatched routes.
 *
 * Without this, an unknown path renders an empty document: React Router
 * matches nothing and the shell has no fallback, so a typo, a stale bookmark,
 * or a shared link with a trailing character lands on a blank cream page with
 * no way back. It reads as an outage rather than a wrong address.
 *
 * `home` differs by surface. Inside the app the way back is the dashboard; on
 * the public site it is the landing page. The layout is deliberately
 * shell-agnostic so the same component can render standalone or inside the
 * authenticated shell's outlet.
 */
export default function NotFound({ home = '/' }: { home?: string }) {
  const location = useLocation();

  useEffect(() => {
    document.title = 'Page not found — Cirqle';
  }, []);

  return (
    <div className="flex min-h-[60svh] items-center justify-center p-6">
      <main
        className="animate-fade-slide-up flex max-w-sm flex-col items-center gap-4 rounded-card border border-dashed border-ink/25 px-8 py-12 text-center"
        aria-labelledby="not-found-title"
      >
        <Compass size={22} className="text-muted" aria-hidden="true" />
        <h1 id="not-found-title" className="font-serif text-2xl font-bold italic">
          Nothing at this address.
        </h1>
        <p className="font-mono text-xs leading-relaxed text-muted">
          {/* Echoing the path back makes a typo self-evident, and it is the
              visitor's own URL — never a value from another user's record. */}
          <span className="break-all">{location.pathname}</span> doesn’t match a
          page here. The link may be mistyped or retired. Nothing was lost.
        </p>
        <Link to={home}>
          <Button variant="outline" size="sm">
            {home === '/' ? 'Back to Cirqle' : 'Back to dashboard'}
          </Button>
        </Link>
      </main>
    </div>
  );
}
