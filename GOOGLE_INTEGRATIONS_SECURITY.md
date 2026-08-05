# Google integrations security and release gate

Calendar and Gmail remain in preview mode unless both browser variables and
all server variables below are explicitly configured. There is no production
origin, project, callback, or credential fallback.

## Required Vercel configuration

Server-only:

```text
INTEGRATIONS_LIVE_ENABLED=true
INTEGRATIONS_APP_ORIGIN=https://your-exact-canonical-origin.example
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
GOOGLE_TOKEN_ENCRYPTION_KEY=<base64-encoded 32-byte key>
GOOGLE_OAUTH_TEST_MODE=true
```

Browser-build variables:

```text
VITE_INTEGRATIONS_MODE=live
VITE_INTEGRATIONS_API_BASE=/api/integrations
```

Remove `GOOGLE_OAUTH_TEST_MODE` after Google changes the consent screen to In
production. Never prefix Google credentials with `VITE_`.

Generate `GOOGLE_TOKEN_ENCRYPTION_KEY` once with a cryptographically secure
32-byte random source, encode it as standard base64, and keep it stable across
deployments. Losing or changing it makes existing Google credential envelopes
unreadable; rotation therefore requires an explicit reconnect or migration
plan.

The exact authorized redirect URI in Google Cloud must be:

```text
https://your-exact-canonical-origin.example/api/integrations/oauth/callback
```

## Security properties

- `/oauth/start` accepts POST only, requires a verified and non-revoked
  Firebase ID token, and rejects cross-origin browser requests.
- The state returned to Google is 256 random bits. Firestore stores only its
  SHA-256 hash with UID, provider, canonical callback, ten-minute expiry, and
  a server-held PKCE verifier.
- `/oauth/callback` accepts no UID or provider from the browser. It consumes
  the state document in a Firestore transaction before exchanging the code.
- The callback calls Google's verified user-info endpoint and binds the saved
  connection to the actual selected Google subject and verified email. A login
  hint is convenience only and is never trusted as the selected identity.
- The granted scope set must contain the requested provider scopes and may
  contain only the explicitly reviewed Calendar, Gmail, and identity scopes.
- The callback and every post-consent redirect use
  `INTEGRATIONS_APP_ORIGIN`; request Host and forwarding headers are ignored.
- Refresh/access tokens live only in
  `oauthTokens/{uid}/providers/{provider}`. Firestore rules deny that entire
  tree to browsers. Tokens are sealed with AES-256-GCM, a fresh nonce, and
  UID/provider-bound authenticated context before they are written.
- Google incremental authorization creates one user/app grant. Disconnect is
  therefore one explicit **Disconnect Google** operation: it revokes every
  stored grant first, deletes both Calendar and Gmail credentials, and marks
  both connection states disconnected. The UI must not promise independent
  revocation.
- Gmail accepts one normalized email address, rejects control characters and
  CR/LF header injection, bounds subject/body size, and validates every Gmail
  message/thread/history identifier.
- Every Gmail send requires a durable outreach-record idempotency key. A
  completed retry replays the saved provider result without sending again;
  reuse with different content is rejected; an interrupted pending send fails
  closed as `send_status_unknown` so a timeout cannot silently duplicate mail.
- Only thread IDs recorded by a successful Cirqle send are eligible for Gmail
  status polling.
- OAuth start, disconnect, Calendar fetch, Gmail send, and Gmail poll each use
  authenticated, per-user rate limits backed by the distributed limiter in
  preview and production.
- Responses and logs contain stable codes, request IDs, and provider HTTP
  status only. Provider bodies, OAuth codes, tokens, Firebase UIDs, email
  content, and raw errors are not logged.
- Authenticated endpoints emit no CORS allow-origin header. Bearer tokens are
  not cookie credentials; an Origin, when present, must exactly match the
  canonical app origin and `Sec-Fetch-Site: cross-site` is denied.

## Required live checks before enabling

1. Deploy to a non-production Vercel preview backed by a non-production
   Firebase project and Google OAuth client.
2. Add a Firestore TTL policy for collection group `_oauthStates`, field
   `expiresAt`, and verify the shared TTL inventory in `SECURITY_RELEASE.md`.
3. Confirm the Google redirect URI exactly matches the preview canonical
   origin and callback path.
4. Confirm missing/revoked Firebase tokens, unverified email, wrong Origin,
   unknown providers, replayed state, expired state, and malformed Gmail
   inputs all fail without a Google request.
5. Complete Calendar and Gmail consent with a disposable Google test user.
   Select an account different from any login hint and confirm the connection
   metadata shows the account actually selected. Confirm no token appears in
   browser storage, Firestore client reads, Vercel response bodies, or logs,
   and confirm Firestore contains only an authenticated token envelope.
6. Send one message to an owned test inbox, retry the same outreach operation,
   and confirm exactly one provider message exists. Confirm a changed payload
   with the same idempotency key is rejected, then poll only the recorded
   thread.
7. Use **Disconnect Google** from either connection entry and verify every
   stored Google grant is revoked, both provider credential documents are
   deleted, and both status records transition to disconnected.
8. Delete the Cirqle test account and verify every provider token is revoked
   before the OAuth credential tree is deleted.
9. Keep `INTEGRATIONS_LIVE_ENABLED` false in production until all checks pass.
