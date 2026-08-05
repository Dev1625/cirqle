# Account lifecycle release guide

This guide covers the authentication recovery, email verification, session
revocation, user-data export, and complete account-deletion implementation on
`codex/full-product-hardening`.

No raw Firebase token, Google OAuth token, LiteLLM virtual key, master key, or
provider response body may be logged, returned in an error, or included in an
account export.

## User-facing flows

- `/login?mode=forgot` sends a non-enumerating Firebase password-reset email.
- `/auth/action` supports Firebase `resetPassword` and `verifyEmail` action
  codes when configured as the project's custom email action handler.
- Signup gives live password guidance and sends an email-verification message.
- Unverified email/password accounts receive a Firestore-free verification
  shell where they can resend verification, reset their password, sign out, or
  delete the pending account. Private workspace reads, export, session
  management, paid AI, public-card publishing, and external connections remain
  locked until verification.
- Settings → Account & Security provides verification/resend, password-reset,
  a privacy-safe 90-day browser-activity list, private export, sign out
  everywhere, and permanent deletion.
- Export, session revocation, and deletion require a fresh password or Google
  reauthentication in the UI. The server independently enforces recent login
  for all three sensitive actions.

## First-party endpoints

All endpoints derive the account UID exclusively from a verified, revocation-
checked Firebase Bearer token. A client-supplied UID is never authoritative.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/account/export` | Downloads a recursive, credential-scrubbed JSON export. |
| `POST` | `/api/account/revoke-sessions` | Revokes all Firebase refresh sessions after recent login. |
| `DELETE` | `/api/account/delete` | Runs complete ordered deletion after recent login and exact `DELETE` confirmation. |

Account deletion is deliberately ordered and retry-safe:

1. Delete the deterministic managed LiteLLM key, any ownership-verified legacy
   key, and the associated LiteLLM user record.
2. Revoke the Google refresh/access credential and recursively delete
   `oauthTokens/{uid}`.
3. Recursively delete every `cards` document owned by the UID, including
   nested captures.
4. Recursively delete `users/{uid}`, including every subcollection.
5. Delete Firebase Authentication last.

Every step tolerates already-missing state. If a pre-Auth step fails, the Auth
record remains so the owner can reauthenticate and retry. Two concurrent
requests cannot turn a missing resource into a failure. A legacy LiteLLM key
is deleted only when its key/user metadata, Firebase UID, or account email
proves ownership.

The administrator orphan audit is dry-run by default:

```sh
npm run audit:orphans
```

It compares paginated Firebase Auth users with root Firestore accounts and
prints only hashed subjects. Cleanup requires both
`--apply --confirm=DELETE-ORPHAN-ACCOUNTS` and the server-side
`CIRQLE_ORPHAN_CLEANUP_ALLOW=true` switch. It reuses the same ordered,
idempotent deletion pipeline; never paste-delete orphan documents in a
console.

## Required environment

The Vercel runtime needs the same server-only configuration used by secure AI
provisioning:

- `FIREBASE_SERVICE_ACCOUNT_JSON`, or the split
  `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
  `FIREBASE_PRIVATE_KEY` values, with permission to read/delete Firestore data,
  revoke sessions, and delete Firebase Auth users.
- `LITELLM_MASTER_KEY`.
- `LITELLM_GATEWAY_URL`.
- `LITELLM_KEY_DERIVATION_SECRET`. Keep this stable across master-key rotation;
  changing it without a migration makes deterministic key lookup impossible.

Never prefix any of these values with `VITE_`.

## Firebase console prerequisites

These settings cannot be safely inferred or deployed from application code:

1. In Authentication → Settings → Password policy, enforce the same policy as
   the UI: 10–128 characters, uppercase, lowercase, and a number or symbol.
   Keep enforcement enabled, not notification-only, so direct Firebase API
   calls cannot bypass the UI.
2. Enable email-enumeration protection so Firebase's direct API behavior
   matches Cirqle's non-enumerating reset and sign-in copy.
3. In Authentication → Templates, set the custom email action handler to:
   `https://<production-domain>/auth/action`.
4. Customize and verify the password-reset and email-verification templates,
   sender name, reply-to address, and authorized production domain.
5. Add every Vercel preview domain used for auth testing to Firebase
   Authorized domains, or test email actions only on the stable production
   candidate domain.
6. Enable Firestore TTL for `_accountSecurity.expiresAt` and
   `_accountDeletionReceipts.expiresAt`. Only deleted-account security
   tombstones receive `expiresAt`; active account locks remain durable.
   Deletion receipts are opaque and expire after one year. Also verify the
   shared security TTL policies for `_oauthStates.expiresAt` and
   `captureGuards.expiresAt`.

The Firebase default email handler remains a functional fallback until item 2
is changed, but it does not use Cirqle's password-strength UI.

## Verification

Focused offline checks:

```sh
node --test tests/account-lifecycle.test.mjs
npx tsx --test tests/auth-security.test.ts
npm run lint
npm run build
```

Production-candidate smoke test:

1. Create a new email/password account with a weak password and confirm both
   client and Firebase policy reject it.
2. Create a strong-password account. Confirm the verification message is
   sanitized, resend is rate-limited in the UI, and paid AI returns the
   verification-required state before verification.
3. Open the verification link. Refresh verification state and confirm AI,
   public card, and external connections unlock.
4. Request a password reset for both an existing and nonexistent email. Both
   browser responses must be indistinguishable.
5. Complete a reset and confirm older sessions can no longer refresh.
6. Create contacts, nested notes/history, a template, tracker state, a card
   with capture, and integration status. Export and verify all user-owned data
   is present while key/token/secret fields are absent.
7. Sign in on two browsers, confirm both coarse browser labels appear without
   IP addresses or full user agents, use “Sign out everywhere,” and confirm
   both sessions are rejected on refresh and the registry is cleared.
8. Populate the same representative data again, then delete the account.
   Confirm no Firebase Auth user, `users/{uid}` tree, card/captures,
   `oauthTokens/{uid}`, LiteLLM key, or LiteLLM user remains.
9. Interrupt deletion at each injected test boundary and retry. Firebase Auth
   must remain until every preceding resource is gone.
10. Inspect Vercel, Firebase, Google, and LiteLLM logs for raw credentials,
    provider bodies, stack traces, email addresses in errors, or exported
    secret fields.
