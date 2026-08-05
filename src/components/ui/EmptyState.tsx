import * as React from 'react';

export interface EmptyStateProps {
  icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** Compact legacy API used by existing dashboard and AI surfaces. */
  line?: string;
  action?: React.ReactNode;
  /** Structured API for setup and no-results states that need more direction. */
  eyebrow?: string;
  title?: string;
  description?: string;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  tertiaryAction?: React.ReactNode;
  status?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  line,
  action,
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  status = false,
  className = '',
}: EmptyStateProps) {
  const headingId = React.useId();
  const descriptionId = React.useId();
  const resolvedDescription = description || line || '';
  const resolvedPrimaryAction = primaryAction || action;
  const isStructured = Boolean(title);

  return (
    <section
      className={`border border-dashed text-center ${
        isStructured
          ? 'border-ink/20 bg-[#F8F5EF] p-7 sm:p-10'
          : 'flex flex-col items-center justify-center gap-3 rounded-card border-ink/25 px-6 py-10'
      } ${className}`}
      aria-labelledby={title ? headingId : undefined}
      aria-describedby={descriptionId}
      role={status ? 'status' : undefined}
    >
      <div className={isStructured ? 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-[#8C7A65]/30 bg-white text-[#76562F]' : ''}>
        <Icon size={isStructured ? 22 : 20} className={isStructured ? undefined : 'text-muted'} aria-hidden="true" />
      </div>
      {eyebrow && (
        <p className="mb-2 font-mono text-[9px] font-bold uppercase tracking-widest text-subtle">
          {eyebrow}
        </p>
      )}
      {title && (
        <h2 id={headingId} className="font-serif text-2xl font-bold italic">
          {title}
        </h2>
      )}
      <p
        id={descriptionId}
        className={isStructured
          ? 'mx-auto mt-2 max-w-xl text-sm leading-relaxed text-subtle'
          : 'max-w-xs font-mono text-xs leading-relaxed text-muted'}
      >
        {resolvedDescription}
      </p>
      {(resolvedPrimaryAction || secondaryAction || tertiaryAction) && (
        <div className={isStructured ? 'mt-5 flex flex-wrap justify-center gap-2' : ''}>
          {resolvedPrimaryAction}
          {secondaryAction}
          {tertiaryAction}
        </div>
      )}
    </section>
  );
}
