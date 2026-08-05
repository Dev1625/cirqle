import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptSensitiveNote,
  encryptSensitiveNote,
  isSensitiveNote,
  migrateSensitiveNoteEnvelope,
  sensitiveNoteRecord,
  sensitiveNoteNeedsMigration,
  SensitiveNoteError,
} from '../src/lib/sensitiveNotes';

const context = { uid: 'owner-uid', noteId: 'note-1' };

test('sensitive note round-trip stores ciphertext, never plaintext', async () => {
  const plaintext = 'Confidential succession plan for the board.';
  const envelope = await encryptSensitiveNote(
    plaintext,
    'this passphrase is private',
    context,
  );
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(plaintext), false);
  assert.deepEqual(envelope.aad, {
    version: 1,
    scope: 'user-note',
    userId: context.uid,
    noteId: context.noteId,
  });
  assert.equal(
    await decryptSensitiveNote(
      envelope,
      'this passphrase is private',
      context,
    ),
    plaintext,
  );

  const record = sensitiveNoteRecord(envelope);
  assert.equal(record.content, null);
  assert.equal(record.aiAllowed, false);
  assert.equal(record.sensitive, true);
  assert.equal(isSensitiveNote(record), true);
});

test('wrong passphrase and tampering return one safe failure boundary', async () => {
  const envelope = await encryptSensitiveNote(
    'private',
    'correct horse battery staple',
    context,
  );
  await assert.rejects(
    decryptSensitiveNote(
      envelope,
      'another strong passphrase',
      context,
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'decrypt_failed' &&
      !error.message.includes('private'),
  );

  await assert.rejects(
    decryptSensitiveNote(
      { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` },
      'correct horse battery staple',
      context,
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      ['decrypt_failed', 'invalid_envelope'].includes(error.code),
  );
});

test('weak passphrases and empty notes are rejected before encryption', async () => {
  await assert.rejects(
    encryptSensitiveNote('secret', 'short', context),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'weak_passphrase',
  );
  await assert.rejects(
    encryptSensitiveNote(
      '   ',
      'this passphrase is private',
      context,
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'invalid_plaintext',
  );
});

test('v2 ciphertext is bound to the exact owner and note record', async () => {
  const envelope = await encryptSensitiveNote(
    'Record-bound secret',
    'correct horse battery staple',
    context,
  );
  await assert.rejects(
    decryptSensitiveNote(
      envelope,
      'correct horse battery staple',
      { ...context, noteId: 'note-2' },
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'decrypt_failed',
  );
  await assert.rejects(
    decryptSensitiveNote(
      envelope,
      'correct horse battery staple',
      { ...context, uid: 'other-owner' },
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'decrypt_failed',
  );
  const rewrittenBinding = {
    ...envelope,
    aad: {
      ...envelope.aad,
      noteId: 'note-2',
    },
  };
  await assert.rejects(
    decryptSensitiveNote(
      rewrittenBinding,
      'correct horse battery staple',
      { ...context, noteId: 'note-2' },
    ),
    (error: unknown) =>
      error instanceof SensitiveNoteError &&
      error.code === 'decrypt_failed',
  );
});

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function legacyEnvelope(
  plaintext: string,
  passphrase: string,
) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: 310_000,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(
        'cirqle-sensitive-note-v1',
      ),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    schemaVersion: 1 as const,
    algorithm: 'AES-GCM' as const,
    kdf: 'PBKDF2-SHA256' as const,
    iterations: 310_000,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

test('legacy v1 notes decrypt and migrate into record-bound v2 envelopes', async () => {
  const passphrase = 'correct horse battery staple';
  const legacy = await legacyEnvelope('Legacy secret', passphrase);
  assert.equal(sensitiveNoteNeedsMigration(legacy), true);
  assert.equal(
    await decryptSensitiveNote(legacy, passphrase),
    'Legacy secret',
  );
  const migrated = await migrateSensitiveNoteEnvelope(
    legacy,
    passphrase,
    context,
  );
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(sensitiveNoteNeedsMigration(migrated), false);
  assert.equal(
    await decryptSensitiveNote(migrated, passphrase, context),
    'Legacy secret',
  );
});
