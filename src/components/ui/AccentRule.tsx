import React from 'react';

/**
 * A short oxblood rule set above a page title.
 *
 * The accent's job in this system is to be narrow but *confident*. Used once
 * per session it just reads as washed-out; one recurring mark at the top of
 * every page turns it into a deliberate thread through the app without
 * recolouring anything that carries meaning (tier, status, industry lane).
 * Purely decorative — hidden from assistive tech.
 */
export function AccentRule({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`h-[3px] w-10 bg-brand ${className}`} />;
}
