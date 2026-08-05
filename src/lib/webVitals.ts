type MetricName = 'CLS' | 'FCP' | 'INP' | 'LCP' | 'TTFB';

interface Metric {
  name: MetricName;
  value: number;
}

function safeRoute(pathname: string): string {
  if (/^\/app\/directory\/[^/]+/.test(pathname)) {
    return '/app/directory/:contactId';
  }
  return pathname.slice(0, 120);
}

export function monitorAppWebVitals(): void {
  if (
    typeof window === 'undefined' ||
    !window.location.pathname.startsWith('/app') ||
    typeof PerformanceObserver === 'undefined'
  ) {
    return;
  }

  // Stable per-page sampling keeps monitoring inexpensive while still
  // surfacing regressions in a small beta. Local development always records
  // to the console only and never calls the production endpoint.
  const sampled =
    import.meta.env.DEV || Math.random() < 0.25;
  if (!sampled) return;

  const metrics = new Map<MetricName, number>();
  const observers: PerformanceObserver[] = [];
  const observe = (
    type: string,
    callback: (entries: PerformanceEntry[]) => void,
  ) => {
    try {
      const observer = new PerformanceObserver((list) =>
        callback(list.getEntries()),
      );
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch {
      // Older browsers simply omit unsupported metrics.
    }
  };

  observe('paint', (entries) => {
    const fcp = entries.find((entry) => entry.name === 'first-contentful-paint');
    if (fcp) metrics.set('FCP', fcp.startTime);
  });
  observe('largest-contentful-paint', (entries) => {
    const last = entries.at(-1);
    if (last) metrics.set('LCP', last.startTime);
  });
  observe('layout-shift', (entries) => {
    const total = entries.reduce((sum, entry) => {
      const shift = entry as PerformanceEntry & {
        value?: number;
        hadRecentInput?: boolean;
      };
      return shift.hadRecentInput ? sum : sum + (shift.value || 0);
    }, metrics.get('CLS') || 0);
    metrics.set('CLS', total);
  });
  observe('event', (entries) => {
    const worst = Math.max(
      metrics.get('INP') || 0,
      ...entries.map((entry) => entry.duration || 0),
    );
    if (worst > 0) metrics.set('INP', worst);
  });

  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (navigation) {
    metrics.set('TTFB', Math.max(0, navigation.responseStart));
  }

  let sent = false;
  const flush = () => {
    if (sent || metrics.size === 0) return;
    sent = true;
    observers.forEach((observer) => observer.disconnect());
    const payload = {
      route: safeRoute(window.location.pathname),
      metrics: [...metrics].map(([name, value]) => ({
        name,
        value: Number(value.toFixed(name === 'CLS' ? 4 : 1)),
      })),
      viewport: {
        widthBucket: Math.ceil(window.innerWidth / 160) * 160,
        mobile: window.matchMedia('(pointer: coarse)').matches,
      },
    };

    if (import.meta.env.DEV) {
      console.info('[web-vitals]', payload);
      return;
    }
    void fetch('/api/telemetry/vitals', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Telemetry is best-effort and must never affect navigation.
    });
  };

  window.addEventListener('pagehide', flush, { once: true });
  window.setTimeout(flush, 15_000);
}
