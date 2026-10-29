// In-memory implementation of the Store interface, so protocol tests run without PostgreSQL or the pg driver.
// It mirrors src/store.js (including sync-token and change-log semantics); keep the two in step.
import { createHash } from 'node:crypto';

import { OP } from '../src/ops.js';
const COLLECTION_FIELDS = ['displayname', 'description', 'color', 'timezone', 'components', 'sort_order'];
const toInt = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
const copy = (row) => (row ? { ...row } : null);

export class MemoryStore {
  users = new Map();
  collections = new Map();
  objects = new Map(); // collection id -> Map(uri -> row)
  changes = new Map(); // collection id -> [{ id, uri, sync_token, operation }]
  #userSeq = 1;
  #collectionSeq = 1;
  #objectSeq = 1;
  #changeSeq = 1;

  async close() {}
  async transaction(fn) { return fn(this); }

  // ---- users ---------------------------------------------------------------

  async createUser({ username, passwordHash, displayName, email = null, isAdmin = false }) {
    const name = username.toLowerCase();
    if ([...this.users.values()].some((u) => u.username === name)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    const user = {
      id: this.#userSeq++, username: name, password_hash: passwordHash, display_name: displayName ?? name,
      email, is_admin: isAdmin, created_at: Math.floor(Date.now() / 1000),
    };
    this.users.set(user.id, user);
    await this.createCollection(user.id, 'calendar', 'default', { displayname: 'Default calendar' });
    await this.createCollection(user.id, 'addressbook', 'default', { displayname: 'Default address book' });
    return copy(user);
  }

  async getUserByName(username) { return copy([...this.users.values()].find((u) => u.username === username.toLowerCase())); }
  async getUserById(id) { return copy(this.users.get(id)); }
  async getUserByEmail(email) {
    const want = email.toLowerCase();
    return copy([...this.users.values()].find((u) => u.email && u.email.toLowerCase() === want));
  }
  async countUsers() { return this.users.size; }
  async lockAdmins() { return [...this.users.values()].filter((u) => u.is_admin).map((u) => u.id); }

  async listUsers() {
    return [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username)).map(copy);
  }

  async listUsersWithStats() {
    return (await this.listUsers()).map((u) => {
      const own = [...this.collections.values()].filter((c) => c.user_id === u.id);
      return {
        ...u,
        calendars: own.filter((c) => c.type === 'calendar').length,
        addressbooks: own.filter((c) => c.type === 'addressbook').length,
      };
    });
  }

  async updateUser(id, { passwordHash, displayName, email, isAdmin }) {
    const u = this.users.get(id);
    if (!u) return;
    if (passwordHash !== undefined) u.password_hash = passwordHash;
    if (displayName !== undefined) u.display_name = displayName;
    if (email !== undefined) u.email = email;
    if (isAdmin !== undefined) u.is_admin = isAdmin;
  }

  async deleteUser(id) {
    if (!this.users.delete(id)) return false;
    for (const c of [...this.collections.values()]) if (c.user_id === id) await this.deleteCollection(c.id);
    for (const [t, l] of this.locks) if (l.user_id === id) this.locks.delete(t);
    for (const [k, p] of this.deadProps) if (p.user_id === id) this.deadProps.delete(k);
    return true;
  }

  // ---- collections -----------------------------------------------------------

  async listCollections(userId, type) {
    const bySort = (a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
    return [...this.collections.values()].filter((c) => c.user_id === userId && c.type === type).sort(bySort).map(copy);
  }

  async getCollection(userId, type, uri) {
    return copy([...this.collections.values()].find((c) => c.user_id === userId && c.type === type && c.uri === uri));
  }

  async getCollectionById(id) { return copy(this.collections.get(id)); }

  async listCollectionsWithCounts(userId) {
    return [...this.collections.values()].filter((c) => c.user_id === userId)
      .sort((a, b) => (a.type + a.uri).localeCompare(b.type + b.uri))
      .map((c) => ({ ...c, object_count: this.objects.get(c.id)?.size ?? 0 }));
  }

  async createCollection(userId, type, uri, props = {}) {
    if (await this.getCollection(userId, type, uri)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    const row = {
      id: this.#collectionSeq++, user_id: userId, type, uri,
      displayname: props.displayname ?? uri, description: props.description ?? null, color: props.color ?? null,
      timezone: props.timezone ?? null, components: props.components ?? 'VEVENT,VTODO,VJOURNAL',
      sort_order: props.sort_order ?? null, sync_token: 1,
    };
    this.collections.set(row.id, row);
    this.objects.set(row.id, new Map());
    this.changes.set(row.id, []);
    return copy(row);
  }

  async updateCollection(id, props) {
    const row = this.collections.get(id);
    if (!row) return;
    for (const k of Object.keys(props)) if (COLLECTION_FIELDS.includes(k)) row[k] = props[k];
  }

  async deleteCollection(id) {
    this.objects.delete(id);
    this.changes.delete(id);
    return this.collections.delete(id);
  }

  async renameCollection(id, uri) {
    const row = this.collections.get(id);
    if (row) row.uri = uri;
  }

  async lockCollection(id) { return this.collections.has(id); }

  // ---- objects -----------------------------------------------------------------

  async listObjects(collectionId, { withData = false, componentType = null, rangeStart = null, rangeEnd = null } = {}) {
    const rows = [...(this.objects.get(collectionId)?.values() ?? [])].filter((o) => {
      if (componentType && o.component_type !== componentType) return false;
      if (rangeEnd != null && o.first_occurrence != null && o.first_occurrence > Math.ceil(rangeEnd / 1000)) return false;
      if (rangeStart != null && o.last_occurrence != null && o.last_occurrence < Math.floor(rangeStart / 1000)) return false;
      return true;
    });
    rows.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    return rows.map(({ data, id, first_occurrence: _f, last_occurrence: _l, collection_id: _c, ...rest }) => (withData ? { ...rest, data } : rest));
  }

  async getObject(collectionId, uri) { return copy(this.objects.get(collectionId)?.get(uri)); }

  async getObjects(collectionId, uris) {
    const map = this.objects.get(collectionId);
    return uris.filter((u) => map?.has(u)).map((u) => copy(map.get(u)));
  }

  async findByUid(collectionId, uid) {
    const row = [...(this.objects.get(collectionId)?.values() ?? [])].find((o) => o.uid === uid);
    return row ? { uri: row.uri } : null;
  }

  async putObject(collection, uri, data, meta) {
    const map = this.objects.get(collection.id);
    if (!map) return null;
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 32);
    const existing = map.get(uri);
    map.set(uri, {
      id: existing?.id ?? this.#objectSeq++, collection_id: collection.id, uri, data, etag,
      size: Buffer.byteLength(data), component_type: meta.componentType, uid: meta.uid,
      first_occurrence: toInt(meta.firstOccurrence), last_occurrence: toInt(meta.lastOccurrence),
      last_modified: Math.floor(Date.now() / 1000),
    });
    this.#recordChange(collection.id, uri, existing ? OP.MODIFIED : OP.ADDED);
    return { created: !existing, etag };
  }

  async deleteObject(collectionId, uri) {
    const map = this.objects.get(collectionId);
    if (!map?.delete(uri)) return false;
    this.#recordChange(collectionId, uri, OP.DELETED);
    return true;
  }

  // ---- locks, dead properties, usage ---------------------------------------------

  locks = new Map();
  deadProps = new Map(); // `${userId}\0${path}\0${name}` -> { user_id, path, name, value }

  async createLock({ token, userId, path, depth, exclusive, owner = null, timeout }) {
    const now = Math.floor(Date.now() / 1000);
    for (const [t, l] of this.locks) if (l.expires_at <= now) this.locks.delete(t);
    const row = { token, user_id: userId, path, depth, exclusive, owner, timeout_secs: timeout, expires_at: now + timeout };
    this.locks.set(token, row);
    return { ...row };
  }

  async listLocks(userId) {
    const now = Math.floor(Date.now() / 1000);
    return [...this.locks.values()].filter((l) => l.user_id === userId && l.expires_at > now).map((l) => ({ ...l }));
  }

  async refreshLock(token, timeout) {
    const row = this.locks.get(token);
    if (!row) return null;
    row.timeout_secs = timeout;
    row.expires_at = Math.floor(Date.now() / 1000) + timeout;
    return { ...row };
  }

  async deleteLock(token) { return this.locks.delete(token); }

  async deletePathState(userId, path) {
    const under = (p) => p === path || p.startsWith(`${path}/`);
    for (const [t, l] of this.locks) if (l.user_id === userId && under(l.path)) this.locks.delete(t);
    for (const [k, p] of this.deadProps) if (p.user_id === userId && under(p.path)) this.deadProps.delete(k);
  }

  async listDeadProps(userId, path) {
    return [...this.deadProps.values()]
      .filter((p) => p.user_id === userId && (p.path === path || p.path.startsWith(`${path}/`)))
      .map(({ path: pp, name, value }) => ({ path: pp, name, value }));
  }

  async setDeadProps(userId, path, sets, removes) {
    const key = (name) => `${userId}\0${path}\0${name}`;
    for (const { name, value } of sets) this.deadProps.set(key(name), { user_id: userId, path, name, value });
    for (const name of removes) this.deadProps.delete(key(name));
  }

  async copyDeadProps(userId, from, to) {
    for (const p of await this.listDeadProps(userId, from)) {
      const dest = to + p.path.slice(from.length);
      this.deadProps.set(`${userId}\0${dest}\0${p.name}`, { user_id: userId, path: dest, name: p.name, value: p.value });
    }
  }

  async usedBytes({ userId, collectionId }) {
    const ids = collectionId != null ? [collectionId] : [...this.collections.values()].filter((c) => c.user_id === userId).map((c) => c.id);
    let total = 0;
    for (const id of ids) for (const o of this.objects.get(id)?.values() ?? []) total += o.size;
    return total;
  }

  async collectionUsage(userId) {
    const out = new Map();
    for (const c of this.collections.values()) {
      if (c.user_id === userId) out.set(c.id, await this.usedBytes({ collectionId: c.id }));
    }
    return out;
  }

  #recordChange(collectionId, uri, operation) {
    const col = this.collections.get(collectionId);
    this.changes.get(collectionId).push({ id: this.#changeSeq++, uri, sync_token: col.sync_token, operation });
    col.sync_token += 1;
  }

  async changesSince(collectionId, token) {
    const latest = new Map();
    for (const ch of this.changes.get(collectionId) ?? []) if (ch.sync_token >= token) latest.set(ch.uri, ch);
    return [...latest.values()].sort((a, b) => a.id - b.id).map(({ uri, operation }) => ({ uri, operation }));
  }
}
