const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LINKED_FACTS = 20;

export class ContactSourceDeleteError extends Error {
  constructor(
    code = 'source_delete_invalid',
    message = 'The source deletion request is invalid.',
    status = 400,
  ) {
    super(message);
    this.name = 'ContactSourceDeleteError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeContactSourceDeleteRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['contactId', 'noteId'].includes(key),
    )
  ) {
    throw new ContactSourceDeleteError();
  }
  const contactId =
    typeof value.contactId === 'string' ? value.contactId.trim() : '';
  const noteId =
    typeof value.noteId === 'string' ? value.noteId.trim() : '';
  if (!DOCUMENT_ID.test(contactId) || !DOCUMENT_ID.test(noteId)) {
    throw new ContactSourceDeleteError();
  }
  return Object.freeze({ contactId, noteId });
}

export function isDeletableContactNoteSource({
  data,
  uid,
  contactId,
  noteId,
}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const canonical =
    data.noteSchemaVersion === 2 &&
    data.recordType === 'note' &&
    data.privacySourceType === 'note' &&
    data.sourceId === noteId &&
    ['quick-note', 'sensitive-note'].includes(data.source);
  const legacy =
    data.noteSchemaVersion == null &&
    ['quick-note', 'sensitive-note'].includes(data.source);
  return (
    data.userId === uid &&
    data.contactId === contactId &&
    (canonical || legacy)
  );
}

export async function deleteContactNoteSource({
  db,
  uid,
  contactId,
  noteId,
}) {
  const contactRef = db.doc(`users/${uid}/contacts/${contactId}`);
  const noteRef = db.doc(`users/${uid}/notes/${noteId}`);
  const factsQuery = db
    .collection(`users/${uid}/contacts/${contactId}/facts`)
    .where('sourceId', '==', noteId)
    .limit(MAX_LINKED_FACTS + 1);
  const [contact, note, facts] = await Promise.all([
    contactRef.get(),
    noteRef.get(),
    factsQuery.get(),
  ]);

  if (!contact.exists || contact.data()?.purgeFence) {
    throw new ContactSourceDeleteError(
      'contact_unavailable',
      'The contact is unavailable.',
      409,
    );
  }
  if (facts.size > MAX_LINKED_FACTS) {
    throw new ContactSourceDeleteError(
      'source_delete_too_large',
      'This source needs administrator review before it can be removed.',
      409,
    );
  }

  if (note.exists) {
    const data = note.data() || {};
    if (!isDeletableContactNoteSource({
      data,
      uid,
      contactId,
      noteId,
    })) {
      throw new ContactSourceDeleteError(
        'source_delete_forbidden',
        'This source cannot be removed through note undo.',
        403,
      );
    }
  }

  for (const fact of facts.docs) {
    const data = fact.data() || {};
    if (
      data.sourceType !== 'note' ||
      data.sourceId !== noteId
    ) {
      throw new ContactSourceDeleteError(
        'source_delete_conflict',
        'The linked memory could not be verified.',
        409,
      );
    }
  }

  if (!note.exists && facts.empty) {
    return Object.freeze({ deleted: false, factsDeleted: 0 });
  }

  const batch = db.batch();
  if (note.exists) batch.delete(noteRef);
  for (const fact of facts.docs) batch.delete(fact.ref);
  await batch.commit();
  return Object.freeze({
    deleted: note.exists,
    factsDeleted: facts.size,
  });
}
