// Scheduling inbox / outbox naming (RFC 6638). The inbox is stored as an ordinary calendar collection with a reserved name.
export const INBOX = 'inbox';
export const OUTBOX = 'outbox';

/** The user's scheduling inbox, created on first use. */
export async function ensureInbox(store, userId) {
  const existing = await store.getCollection(userId, 'calendar', INBOX);
  if (existing) return existing;
  try {
    return await store.createCollection(userId, 'calendar', INBOX, { displayname: 'Scheduling inbox' });
  } catch (err) {
    if (err.code !== '23505') throw err;
    return store.getCollection(userId, 'calendar', INBOX);
  }
}
