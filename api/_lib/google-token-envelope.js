import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 16_384;

function envelopeError() {
  const error = new Error('Google credential envelope is unavailable.');
  error.code = 'google_credential_unavailable';
  error.status = 503;
  return error;
}

function boundedToken(value) {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw envelopeError();
  }
  return value;
}

function decodeBase64Url(value, expectedBytes = null) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw envelopeError();
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    throw envelopeError();
  }
  if (
    decoded.length === 0 ||
    (expectedBytes != null && decoded.length !== expectedBytes)
  ) {
    throw envelopeError();
  }
  return decoded;
}

function normalizedContext(context) {
  if (
    typeof context !== 'string' ||
    !context ||
    Buffer.byteLength(context, 'utf8') > 512 ||
    /[\u0000\r\n]/.test(context)
  ) {
    throw envelopeError();
  }
  return context;
}

export function readGoogleTokenEncryptionKey(
  env = process.env,
  { required = true } = {},
) {
  const encoded = env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    if (!required) return null;
    throw envelopeError();
  }
  let key;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    throw envelopeError();
  }
  if (
    key.length !== 32 ||
    key.toString('base64').replace(/=+$/u, '') !==
      encoded.replace(/=+$/u, '')
  ) {
    throw envelopeError();
  }
  return key;
}

export function sealGoogleTokens(
  {
    accessToken = null,
    refreshToken = null,
  },
  {
    key,
    context,
    randomBytesImpl = randomBytes,
  },
) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw envelopeError();
  }
  const aad = Buffer.from(
    `cirqle-google-oauth:v${ENVELOPE_VERSION}:${normalizedContext(context)}`,
    'utf8',
  );
  const payload = JSON.stringify({
    accessToken: boundedToken(accessToken),
    refreshToken: boundedToken(refreshToken),
  });
  const iv = randomBytesImpl(IV_BYTES);
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    throw envelopeError();
  }
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(payload, 'utf8'),
    cipher.final(),
  ]);
  return Object.freeze({
    v: ENVELOPE_VERSION,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  });
}

export function openGoogleTokens(
  credential,
  {
    key = null,
    context,
  } = {},
) {
  const value =
    credential && typeof credential === 'object' && !Array.isArray(credential)
      ? credential
      : {};
  if (!value.tokenEnvelope) {
    return Object.freeze({
      accessToken: boundedToken(value.accessToken),
      refreshToken: boundedToken(value.refreshToken),
      legacyPlaintext: Boolean(value.accessToken || value.refreshToken),
    });
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw envelopeError();
  }
  const envelope = value.tokenEnvelope;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.v !== ENVELOPE_VERSION ||
    envelope.alg !== 'A256GCM' ||
    Object.keys(envelope).some(
      (field) => !['v', 'alg', 'iv', 'tag', 'ciphertext'].includes(field),
    )
  ) {
    throw envelopeError();
  }
  const aad = Buffer.from(
    `cirqle-google-oauth:v${ENVELOPE_VERSION}:${normalizedContext(context)}`,
    'utf8',
  );
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      decodeBase64Url(envelope.iv, IV_BYTES),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(decodeBase64Url(envelope.tag, AUTH_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(envelope.ciphertext)),
      decipher.final(),
    ]);
    if (plaintext.length > MAX_TOKEN_BYTES * 2 + 256) {
      throw envelopeError();
    }
    const parsed = JSON.parse(plaintext.toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (field) => !['accessToken', 'refreshToken'].includes(field),
      )
    ) {
      throw envelopeError();
    }
    return Object.freeze({
      accessToken: boundedToken(parsed.accessToken),
      refreshToken: boundedToken(parsed.refreshToken),
      legacyPlaintext: false,
    });
  } catch (error) {
    if (error?.code === 'google_credential_unavailable') throw error;
    throw envelopeError();
  }
}
