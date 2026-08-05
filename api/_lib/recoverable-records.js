const RECOVERABLE_COLLECTIONS = Object.freeze([
  {
    collection: 'templates',
    expiresField: 'purgeAfter',
    statusField: 'lifecycleStatus',
  },
  {
    collection: 'outreaches',
    expiresField: 'trackerPurgeAfter',
    statusField: 'trackerLifecycleStatus',
  },
]);

/**
 * Permanently clears only records that already spent their full recovery
 * window in a deleted state. The report contains counts, never user data.
 */
export async function purgeExpiredRecoverableRecords({
  db,
  uid,
  now = new Date(),
  maxMutations = 100,
}) {
  const limit = Math.min(
    400,
    Math.max(1, Math.floor(Number(maxMutations) || 100)),
  );
  let remaining = limit;
  let scanned = 0;
  let deleted = 0;
  let hasMore = false;

  for (const descriptor of RECOVERABLE_COLLECTIONS) {
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    const snapshot = await db
      .collection(`users/${uid}/${descriptor.collection}`)
      .where(descriptor.expiresField, '<=', now)
      .orderBy(descriptor.expiresField)
      .limit(remaining + 1)
      .get();
    scanned += snapshot.size;
    const eligible = snapshot.docs
      .slice(0, remaining)
      .filter(
        (document) =>
          document.data()?.[descriptor.statusField] === 'deleted',
      );
    if (snapshot.size > remaining) hasMore = true;
    if (eligible.length === 0) continue;

    const batch = db.batch();
    for (const document of eligible) batch.delete(document.ref);
    await batch.commit();
    deleted += eligible.length;
    remaining -= eligible.length;
  }

  return Object.freeze({
    scanned,
    deleted,
    hasMore,
  });
}
