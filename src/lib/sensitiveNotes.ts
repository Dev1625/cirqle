const LEGACY_ENVELOPE_VERSION = 1 as const;
const ENVELOPE_VERSION = 2 as const;
const AAD_VERSION = 1 as const;
const AAD_SCOPE = 'user-note' as const;
const ALGORITHM = 'AES-GCM' as const;
const KDF = 'PBKDF2-SHA256' as const;
const DEFAULT_ITERATIONS = 310_000;
const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PLAINTEXT_LENGTH = 20_000;
const MAX_BINDING_LENGTH = 128;
const LEGACY_AAD = new TextEncoder().encode('cirqle-sensitive-note-v1');
const AAD_DOMAIN = new TextEncoder().encode('cirqle-sensitive-note');

export interface SensitiveNoteBinding {
  uid: string;
  noteId: string;
}

export interface SensitiveNoteEnvelopeV1 {
  schemaVersion: typeof LEGACY_ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  kdf: typeof KDF;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface SensitiveNoteEnvelopeV2 {
  schemaVersion: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  kdf: typeof KDF;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  aad: {
    version: typeof AAD_VERSION;
    scope: typeof AAD_SCOPE;
    userId: string;
    noteId: string;
  };
}

export type SensitiveNoteEnvelope =
  | SensitiveNoteEnvelopeV1
  | SensitiveNoteEnvelopeV2;

export interface SensitiveNoteRecord {
  sensitive: true;
  aiAllowed: false;
  content: null;
  encryptedContent: SensitiveNoteEnvelope;
}

export class SensitiveNoteError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_plaintext'
      | 'weak_passphrase'
      | 'invalid_binding'
      | 'invalid_envelope'
      | 'decrypt_failed',
  ) {
    super(message);
    this.name = 'SensitiveNoteError';
  }
}

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new SensitiveNoteError(
      'Encrypted notes are not supported in this browser.',
      'invalid_envelope',
    );
  }
  return globalThis.crypto;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function decodeBase64(
  value: unknown,
  maxBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new SensitiveNoteError(
      'This encrypted note is not valid.',
      'invalid_envelope',
    );
  }
  try {
    const binary = atob(value);
    if (
      binary.length > maxBytes ||
      (exactBytes !== undefined && binary.length !== exactBytes)
    ) {
      throw new Error('invalid length');
    }
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    // Reject alternate/non-canonical encodings before they can become a
    // second serialized representation of the same envelope.
    if (encodeBase64(bytes) !== value) throw new Error('non-canonical');
    return bytes;
  } catch {
    throw new SensitiveNoteError(
      'This encrypted note is not valid.',
      'invalid_envelope',
    );
  }
}

function validatePassphrase(passphrase: unknown): string {
  if (
    typeof passphrase !== 'string' ||
    passphrase.length < MIN_PASSPHRASE_LENGTH ||
    passphrase.length > 512
  ) {
    throw new SensitiveNoteError(
      `Use a private passphrase with at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      'weak_passphrase',
    );
  }
  return passphrase;
}

function validateBinding(value: SensitiveNoteBinding): SensitiveNoteBinding {
  const uid = typeof value?.uid === 'string' ? value.uid.trim() : '';
  const noteId =
    typeof value?.noteId === 'string' ? value.noteId.trim() : '';
  if (
    !uid ||
    !noteId ||
    uid.length > MAX_BINDING_LENGTH ||
    noteId.length > MAX_BINDING_LENGTH ||
    uid.includes('/') ||
    noteId.includes('/')
  ) {
    throw new SensitiveNoteError(
      'This encrypted note has an invalid record binding.',
      'invalid_binding',
    );
  }
  return { uid, noteId };
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/**
 * Canonical, record-bound AES-GCM additional authenticated data.
 *
 * Contact IDs are intentionally absent: contact merge changes that foreign
 * key while the owning user and root note document ID remain stable.
 */
function recordAAD(rawBinding: SensitiveNoteBinding): Uint8Array {
  const binding = validateBinding(rawBinding);
  const userId = new TextEncoder().encode(binding.uid);
  const noteId = new TextEncoder().encode(binding.noteId);
  return concatBytes([
    AAD_DOMAIN,
    uint32(AAD_VERSION),
    uint32(userId.byteLength),
    userId,
    uint32(noteId.byteLength),
    noteId,
  ]);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await cryptoApi().subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return cryptoApi().subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    material,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSensitiveNote(
  plaintext: string,
  passphrase: string,
  rawBinding: SensitiveNoteBinding,
): Promise<SensitiveNoteEnvelopeV2> {
  const normalized = typeof plaintext === 'string' ? plaintext.trim() : '';
  if (!normalized || normalized.length > MAX_PLAINTEXT_LENGTH) {
    throw new SensitiveNoteError(
      'Sensitive notes must contain between 1 and 20,000 characters.',
      'invalid_plaintext',
    );
  }
  const password = validatePassphrase(passphrase);
  const binding = validateBinding(rawBinding);
  const salt = cryptoApi().getRandomValues(new Uint8Array(16));
  const iv = cryptoApi().getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, DEFAULT_ITERATIONS);
  const ciphertext = await cryptoApi().subtle.encrypt(
    {
      name: ALGORITHM,
      iv,
      additionalData: recordAAD(binding),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(normalized),
  );

  return {
    schemaVersion: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    kdf: KDF,
    iterations: DEFAULT_ITERATIONS,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    aad: {
      version: AAD_VERSION,
      scope: AAD_SCOPE,
      userId: binding.uid,
      noteId: binding.noteId,
    },
  };
}

function normalizeEnvelope(
  value: unknown,
  rawBinding?: SensitiveNoteBinding,
): {
  envelope: SensitiveNoteEnvelope;
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  aad: Uint8Array;
  needsMigration: boolean;
} {
  const candidate = value as Partial<SensitiveNoteEnvelope> | null;
  if (
    !candidate ||
    (candidate.schemaVersion !== LEGACY_ENVELOPE_VERSION &&
      candidate.schemaVersion !== ENVELOPE_VERSION) ||
    candidate.algorithm !== ALGORITHM ||
    candidate.kdf !== KDF ||
    candidate.iterations !== DEFAULT_ITERATIONS
  ) {
    throw new SensitiveNoteError(
      'This encrypted note is not valid.',
      'invalid_envelope',
    );
  }

  let aad = LEGACY_AAD;
  if (candidate.schemaVersion === ENVELOPE_VERSION) {
    const envelope = candidate as Partial<SensitiveNoteEnvelopeV2>;
    if (
      !envelope.aad ||
      envelope.aad.version !== AAD_VERSION ||
      envelope.aad.scope !== AAD_SCOPE ||
      typeof envelope.aad.userId !== 'string' ||
      typeof envelope.aad.noteId !== 'string'
    ) {
      throw new SensitiveNoteError(
        'This encrypted note is not valid.',
        'invalid_envelope',
      );
    }
    const embeddedBinding = validateBinding({
      uid: envelope.aad.userId,
      noteId: envelope.aad.noteId,
    });
    const binding = rawBinding
      ? validateBinding(rawBinding)
      : embeddedBinding;
    if (
      embeddedBinding.uid !== binding.uid ||
      embeddedBinding.noteId !== binding.noteId
    ) {
      throw new SensitiveNoteError(
        'That passphrase could not unlock this note.',
        'decrypt_failed',
      );
    }
    aad = recordAAD(binding);
  }

  const ciphertext = decodeBase64(
    candidate.ciphertext,
    MAX_PLAINTEXT_LENGTH * 4 + 32,
  );
  // AES-GCM always appends a 16-byte authentication tag. An empty or
  // tag-only ciphertext cannot represent an accepted non-empty plaintext.
  if (ciphertext.byteLength <= 16) {
    throw new SensitiveNoteError(
      'This encrypted note is not valid.',
      'invalid_envelope',
    );
  }

  return {
    envelope: candidate as SensitiveNoteEnvelope,
    salt: decodeBase64(candidate.salt, 16, 16),
    iv: decodeBase64(candidate.iv, 12, 12),
    ciphertext,
    aad,
    needsMigration:
      candidate.schemaVersion === LEGACY_ENVELOPE_VERSION,
  };
}

export function isLegacySensitiveNoteEnvelope(
  value: unknown,
): value is SensitiveNoteEnvelopeV1 {
  try {
    const normalized = normalizeEnvelope(value);
    return normalized.needsMigration;
  } catch {
    return false;
  }
}

export function sensitiveNoteNeedsMigration(value: unknown): boolean {
  return isLegacySensitiveNoteEnvelope(value);
}

export async function decryptSensitiveNote(
  value: unknown,
  passphrase: string,
  binding?: SensitiveNoteBinding,
): Promise<string> {
  const password = validatePassphrase(passphrase);
  if (
    (value as Partial<SensitiveNoteEnvelope> | null)?.schemaVersion ===
      ENVELOPE_VERSION &&
    !binding
  ) {
    throw new SensitiveNoteError(
      'This encrypted note requires its record binding.',
      'invalid_binding',
    );
  }
  if (binding) validateBinding(binding);
  const { envelope, salt, iv, ciphertext, aad } =
    normalizeEnvelope(value, binding);
  try {
    const key = await deriveKey(password, salt, envelope.iterations);
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: ALGORITHM, iv, additionalData: aad, tagLength: 128 },
      key,
      ciphertext,
    );
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      plaintext,
    );
    if (!decoded || decoded.length > MAX_PLAINTEXT_LENGTH) {
      throw new Error('invalid plaintext');
    }
    return decoded;
  } catch (error) {
    if (error instanceof SensitiveNoteError) throw error;
    throw new SensitiveNoteError(
      'That passphrase could not unlock this note.',
      'decrypt_failed',
    );
  }
}

export async function migrateSensitiveNoteEnvelope(
  value: unknown,
  passphrase: string,
  binding: SensitiveNoteBinding,
): Promise<SensitiveNoteEnvelopeV2> {
  if (!sensitiveNoteNeedsMigration(value)) {
    throw new SensitiveNoteError(
      'This encrypted note does not need migration.',
      'invalid_envelope',
    );
  }
  const plaintext = await decryptSensitiveNote(value, passphrase, binding);
  return encryptSensitiveNote(plaintext, passphrase, binding);
}

export function sensitiveNoteRecord(
  encryptedContent: SensitiveNoteEnvelope,
  binding?: SensitiveNoteBinding,
): SensitiveNoteRecord {
  normalizeEnvelope(encryptedContent, binding);
  return {
    sensitive: true,
    aiAllowed: false,
    content: null,
    encryptedContent,
  };
}

export function isSensitiveNote(
  value: unknown,
  binding?: SensitiveNoteBinding,
): value is SensitiveNoteRecord {
  const candidate = value as Partial<SensitiveNoteRecord> | null;
  if (
    !candidate ||
    candidate.sensitive !== true ||
    candidate.aiAllowed !== false ||
    candidate.content !== null
  ) {
    return false;
  }
  try {
    normalizeEnvelope(candidate.encryptedContent, binding);
    return true;
  } catch {
    return false;
  }
}
