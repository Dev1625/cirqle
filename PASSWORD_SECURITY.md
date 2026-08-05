# Password safety and breached-password screening

Cirqle applies two independent checks whenever a user chooses a new
email/password credential:

1. The existing local policy requires 10–128 characters, uppercase and
   lowercase letters, a number or symbol, and rejects locally known common
   patterns.
2. A privacy-preserving Pwned Passwords range lookup blocks passwords present
   in known breach records.

This covers account signup and the Firebase reset-link screen. Account
Security deliberately changes passwords through that same reset-link screen,
so password changes receive the identical policy.

## Privacy boundary

For the breach-screening step, the raw password never leaves the browser:

```text
password in browser
  -> browser Web Crypto SHA-1
  -> first 5 hex characters only
  -> POST /api/security/password-range
  -> fixed https://api.pwnedpasswords.com/range/{prefix}
  -> padded range of candidate suffixes
  -> suffix comparison in browser
```

The full password, full SHA-1 hash, and 35-character hash suffix are never sent
to Cirqle's Vercel APIs, Vercel logs, or Have I Been Pwned. Firebase still
receives the password over its encrypted authentication channel when the user
submits signup or reset; Cirqle does not replace or intercept that credential
exchange. SHA-1 is used only because the Pwned Passwords k-anonymity protocol
requires it; it is not used to store or authenticate Cirqle credentials.

The proxy:

- accepts exactly one five-character hexadecimal prefix;
- permits only `POST`;
- calls one fixed upstream origin with `Add-Padding: true`;
- preserves provider padding so sparse ranges are not distinguishable by
  response size;
- rejects malformed or oversized responses;
- uses bounded client and server timeouts;
- throttles callers without logging an IP address or prefix;
- never reads an upstream error body; and
- logs only fixed event codes and safe request IDs.

Checks run on password-field blur and final submission, not after each
keystroke. This follows the provider's guidance against incremental searches,
which can expose enough request timing to weaken k-anonymity.

Official protocol reference:
[Have I Been Pwned API — Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords).

## Availability policy

A confirmed corpus match always blocks signup or password replacement.

If the browser is offline, Web Crypto is unavailable, the Cirqle proxy times
out, or Pwned Passwords is unavailable, Cirqle deliberately fails open for
availability:

- the existing local strength and common-password checks still must pass;
- the UI states that known-breach lookup is unavailable; and
- signup/account recovery can continue.

This avoids making an external corpus an account-recovery dependency. It is
especially important for local development, where `npm run dev` may run
without Vercel API functions. To deliberately disable only the remote lookup
for an offline development environment, set:

```text
VITE_PASSWORD_BREACH_CHECK_DISABLED=true
```

Never set that flag in production. No HIBP API key is required.

## Verification

Focused checks:

```sh
node --test tests/password-breach-api.test.mjs tests/password-breach-flow.test.mjs
npx tsx --test tests/password-breach.test.ts
npm run test:api
npm run test:unit
npm run lint
```

Before promotion, verify on a Vercel preview:

1. A locally weak/common password is rejected without a range request.
2. A known breached password is rejected at signup and reset confirmation.
3. A unique generated password passes.
4. DevTools shows a same-origin `POST` body containing only a five-character
   `prefix`; it must not contain the password or suffix.
5. The upstream request uses padding and no application log contains the
   prefix, password, hash, provider response, or provider error body.
6. Simulated proxy failure leaves local policy active and clearly reports the
   availability fallback.
