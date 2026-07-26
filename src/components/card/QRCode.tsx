import React, { useEffect, useState } from 'react';
import QRCodeLib from 'qrcode';

/**
 * QR fallback for the card page. Unsexy, but it saves real friction: NFC is
 * inconsistent across handsets and locked-screen states, and a QR works on
 * anything with a camera.
 *
 * Rendered on paper with ink modules rather than pure black-on-white, so it
 * sits on the page as a printed artefact rather than a pasted-in asset. The
 * light module is opaque paper, not transparent — scanners cope badly with
 * the dot-grid texture showing through the quiet zone.
 */
export function QRCode({
  value,
  size = 160,
  className = '',
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    QRCodeLib.toDataURL(value, {
      width: size * 2, // 2x for crisp rendering on retina and when printed
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1A1A1AFF', light: '#F5F0E8FF' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex items-center justify-center rounded-card border border-dashed border-ink/25 p-3 text-center font-mono text-[10px] uppercase tracking-widest text-muted ${className}`}
      >
        QR unavailable — use the link
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`rounded-card border border-ink/15 bg-paper ${className}`}
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt={`QR code linking to ${value}`}
      className={`animate-fade-in rounded-card border border-ink/15 ${className}`}
    />
  );
}
