import React from 'react';
import {
  AlertTriangle,
  Check,
  Circle,
  LoaderCircle,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';

import {
  assessPassword,
  type PasswordAssessment,
} from '../../lib/authSecurity';
import type { PasswordBreachViewState } from '../../lib/passwordBreach';

export function PasswordStrength({
  password,
  id = 'password-guidance',
  breachState = { status: 'idle' },
}: {
  password: string;
  id?: string;
  breachState?: PasswordBreachViewState;
}) {
  const assessment = assessPassword(password);
  const checks: {
    key: keyof Pick<
      PasswordAssessment,
      'length' | 'lower' | 'upper' | 'numberOrSymbol' | 'notCommon'
    >;
    label: string;
  }[] = [
    { key: 'length', label: '10–128 characters' },
    { key: 'lower', label: 'A lowercase letter' },
    { key: 'upper', label: 'An uppercase letter' },
    { key: 'numberOrSymbol', label: 'A number or symbol' },
    { key: 'notCommon', label: 'Not a common password' },
  ];
  const breachPresentation = (() => {
    if (breachState.status === 'checking') {
      return {
        Icon: LoaderCircle,
        label: 'Checking known breach records…',
        className: 'text-muted',
        iconClassName: 'motion-safe:animate-spin',
      };
    }
    if (breachState.status === 'safe') {
      return {
        Icon: ShieldCheck,
        label: 'Not found in known breach records',
        className: 'text-ink',
        iconClassName: '',
      };
    }
    if (breachState.status === 'breached') {
      return {
        Icon: ShieldX,
        label: 'Found in known breaches — choose another',
        className: 'font-semibold text-red-700',
        iconClassName: '',
      };
    }
    if (breachState.status === 'unavailable') {
      return {
        Icon: AlertTriangle,
        label: 'Breach lookup unavailable; local safeguards still apply',
        className: 'text-amber-800',
        iconClassName: '',
      };
    }
    return {
      Icon: Circle,
      label: assessment.isStrong
        ? 'Leave the field or continue to check known breaches'
        : 'Known-breach check runs after local requirements',
      className: '',
      iconClassName: '',
    };
  })();
  const BreachIcon = breachPresentation.Icon;

  return (
    <div id={id} className="mt-2">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Password strength: {assessment.score} of 5 requirements complete.
      </span>
      <div className="mb-2 flex h-1.5 gap-1" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((level) => (
          <span
            key={level}
            className={`flex-1 rounded-full transition-colors ${
              assessment.score >= level ? 'bg-brand' : 'bg-ink/10'
            }`}
          />
        ))}
      </div>
      <ul
        className="grid grid-cols-1 gap-1 text-[10px] text-muted sm:grid-cols-2"
        aria-label="Password requirements"
      >
        {checks.map((check) => {
          const complete = assessment[check.key];
          const Icon = complete ? Check : Circle;
          return (
            <li
              key={check.key}
              className={`flex items-center gap-1.5 ${
                complete ? 'text-ink' : ''
              }`}
            >
              <Icon size={11} aria-hidden="true" />
              {check.label}
            </li>
          );
        })}
      </ul>
      <div
        className={`mt-2 flex items-start gap-1.5 text-[10px] ${breachPresentation.className}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <BreachIcon
          size={11}
          className={`mt-0.5 shrink-0 ${breachPresentation.iconClassName}`}
          aria-hidden="true"
        />
        <span>{breachPresentation.label}</span>
      </div>
      <p className="mt-1 text-[9px] leading-relaxed text-subtle">
        For this breach check, your password is hashed in this browser. Only a
        five-character hash prefix is checked through Cirqle using{' '}
        <a
          href="https://haveibeenpwned.com/Passwords"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-ink/30 underline-offset-2"
        >
          Pwned Passwords
        </a>
        .
      </p>
    </div>
  );
}
