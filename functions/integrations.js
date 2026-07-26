import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/**
 * The server half of the Gmail / Calendar integrations.
 *
 * WRITTEN BUT NOT TESTED AGAINST GOOGLE. There is no OAuth client yet, so
 * nothing here has run against the real API — only the shapes the client
 * already expects (src/lib/integrations/*.ts). Treat it as a reviewed draft,
 * not proven code, and expect to debug the first live consent round-trip.
 *
 * THE ONE INVARIANT: a refresh token is a standing key to someone's mailbox
 * that survives their password change. It is written to `oauthTokens/{uid}`,
 * which firestore.rules denies to every client unconditionally, and it is
 * never returned to the browser in any response. The browser's only part in
 * this is being redirected to Google and back.
 */

const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');

const db = () => getFirestore();

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Exchanges an authorization code for tokens, or refreshes an access token. */
async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`Google token endpoint ${response.status}: ${body.error_description || body.error}`);
    error.googleError = body.error;
    throw error;
  }
  return body;
}

/**
 * Returns a usable access token for a user, refreshing if needed.
 *
 * Throws `reauth-required` when Google has revoked the grant. While the app is
 * in "testing" publishing status Google expires refresh tokens after 7 days,
 * so this is a routine, expected path — not an exceptional one — and the
 * client turns it into the Reconnect affordance rather than an error toast.
 */
async function getAccessToken(uid) {
  const ref = db().doc(`oauthTokens/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('not-connected'), { code: 'not-connected' });

  const data = snap.data();
  const expiresAt = data.accessTokenExpiresAt?.toDate?.();

  // 60s of slack so a token cannot expire mid-request.
  if (data.accessToken && expiresAt && expiresAt.getTime() - 60_000 > Date.now()) {
    return data.accessToken;
  }

  if (!data.refreshToken) throw Object.assign(new Error('reauth-required'), { code: 'reauth-required' });

  let refreshed;
  try {
    refreshed = await tokenRequest({
      client_id: GOOGLE_CLIENT_ID.value(),
      client_secret: GOOGLE_CLIENT_SECRET.value(),
      refresh_token: data.refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (error) {
    // invalid_grant means revoked or expired — the 7-day testing-mode case.
    if (error.googleError === 'invalid_grant') {
      await ref.set({ needsReauth: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw Object.assign(new Error('reauth-required'), { code: 'reauth-required' });
    }
    throw error;
  }

  const accessToken = refreshed.access_token;
  await ref.set({
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
    needsReauth: false,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return accessToken;
}

/** Mirrors connection state into the client-readable status doc (never tokens). */
async function writeStatus(uid, provider, patch) {
  await db().doc(`users/${uid}/integrations/${provider}`).set(
    { provider, mode: 'live', updatedAt: FieldValue.serverTimestamp(), ...patch },
    { merge: true }
  );
}

async function requireUid(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw Object.assign(new Error('unauthenticated'), { code: 'unauthenticated' });
  const decoded = await getAuth().verifyIdToken(match[1]);
  return decoded.uid;
}

function fail(res, error) {
  const code = error.code || 'internal';
  const status = code === 'unauthenticated' ? 401
    : code === 'reauth-required' ? 428      // Precondition Required — reconnect
    : code === 'not-connected' ? 409
    : 500;
  console.error(`[integrations] ${code}`, error.message);
  res.status(status).json({ error: code });
}

/**
 * GET /oauth/callback — Google redirects here with ?code and ?state.
 *
 * Deliberately NOT authenticated by header: this is a top-level browser
 * navigation from Google, which cannot carry one. The uid comes from `state`,
 * which is why state must be treated as untrusted input and the flow must be
 * initiated by an authenticated client.
 */
export const oauthCallback = onRequest(
  { secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const { code, state, error: googleError } = req.query;
      if (googleError) return res.redirect(`/app/settings?connect=denied`);
      if (!code || !state) return res.status(400).send('Missing code or state');

      let parsed;
      try {
        parsed = JSON.parse(String(state));
      } catch {
        return res.status(400).send('Malformed state');
      }
      const { uid, provider } = parsed;
      if (!uid || !provider) return res.status(400).send('Incomplete state');

      const redirectUri = `${req.protocol}://${req.get('host')}/api/integrations/oauth/callback`;
      const tokens = await tokenRequest({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID.value(),
        client_secret: GOOGLE_CLIENT_SECRET.value(),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      // Google only returns a refresh_token on the first consent (or when
      // prompt=consent forces it). Never overwrite a stored one with undefined.
      const patch = {
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
        scope: tokens.scope || null,
        needsReauth: false,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (tokens.refresh_token) patch.refreshToken = tokens.refresh_token;

      await db().doc(`oauthTokens/${uid}`).set(patch, { merge: true });

      await writeStatus(uid, provider, {
        connected: true,
        connectedAt: FieldValue.serverTimestamp(),
        lastSyncedAt: FieldValue.serverTimestamp(),
        // Testing-status refresh tokens die after 7 days; surfacing the date
        // is what turns that into an expected Reconnect rather than a bug.
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      });

      res.redirect('/app/settings?connect=ok');
    } catch (error) {
      console.error('[oauthCallback]', error);
      res.redirect('/app/settings?connect=error');
    }
  }
);

/** GET /calendar/upcoming — read-only, next 7 days. */
export const calendarUpcoming = onRequest(
  { secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const uid = await requireUid(req);
      const accessToken = await getAccessToken(uid);

      const now = new Date();
      const week = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.searchParams.set('timeMin', now.toISOString());
      url.searchParams.set('timeMax', week.toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '25');

      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`Calendar API ${response.status}`);
      const payload = await response.json();

      const events = (payload.items || []).map((item) => ({
        id: item.id,
        title: item.summary || '(no title)',
        start: item.start?.dateTime || item.start?.date,
        end: item.end?.dateTime || item.end?.date,
        location: item.location || null,
        attendees: (item.attendees || []).map((a) => a.email).filter(Boolean),
      }));

      await writeStatus(uid, 'calendar', { lastSyncedAt: FieldValue.serverTimestamp() });
      res.json({ events, syncedAt: new Date().toISOString() });
    } catch (error) {
      fail(res, error);
    }
  }
);

/** POST /gmail/send — RFC 2822 message, base64url encoded, via gmail.send. */
export const gmailSend = onRequest(
  { secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const uid = await requireUid(req);
      const { to, subject, body } = req.body || {};
      if (!to || !subject) return res.status(400).json({ error: 'missing to/subject' });

      const accessToken = await getAccessToken(uid);

      // Subject is RFC 2047 encoded so non-ASCII does not corrupt the header.
      const mime = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(String(subject), 'utf8').toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        String(body || ''),
      ].join('\r\n');

      const raw = Buffer.from(mime, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!response.ok) throw new Error(`Gmail send ${response.status}: ${await response.text()}`);
      const sent = await response.json();

      await writeStatus(uid, 'gmail', { lastSyncedAt: FieldValue.serverTimestamp() });
      res.json({ threadId: sent.threadId, messageId: sent.id });
    } catch (error) {
      fail(res, error);
    }
  }
);

/**
 * POST /gmail/poll — checks only the threads Cirqle itself created.
 *
 * Uses format=metadata, which is all the gmail.metadata scope permits: headers
 * and label ids, never message bodies. That is the scope choice enforcing
 * itself — the app *cannot* read mail it did not send even if it wanted to.
 */
export const gmailPoll = onRequest(
  { secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const uid = await requireUid(req);
      const { threadIds = [] } = req.body || {};
      const accessToken = await getAccessToken(uid);

      const statuses = {};
      // Sequential on purpose: a handful of threads, and Gmail's per-user rate
      // limit punishes bursts harder than it does latency.
      for (const threadId of threadIds.slice(0, 50)) {
        const response = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!response.ok) continue;
        const thread = await response.json();
        const messages = thread.messages || [];

        // More than one message, and the latest is not from us => they replied.
        const latest = messages[messages.length - 1];
        const fromSelf = (latest?.labelIds || []).includes('SENT');
        statuses[threadId] = messages.length > 1 && !fromSelf ? 'replied' : 'delivered';
      }

      const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then((r) => (r.ok ? r.json() : null));

      await writeStatus(uid, 'gmail', { lastSyncedAt: FieldValue.serverTimestamp() });
      res.json({ statuses, historyId: profile?.historyId || null });
    } catch (error) {
      fail(res, error);
    }
  }
);
