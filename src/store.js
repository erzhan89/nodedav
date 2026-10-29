import pg from 'pg';
import { createHash } from 'node:crypto';
import { OP } from './ops.js';

const SCHEMA_VERSION = 2;
const MIGRATION_LOCK_KEY = 727_274;
const PG_INT8 = 20;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const MIGRATIONS = [
  // 1
  `
  CREATE TABLE users (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    email         TEXT,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    BIGINT NOT NULL
  );

  CREATE TABLE collections (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('calendar', 'addressbook')),
    uri         TEXT NOT NULL,
    displayname TEXT,
    description TEXT,
    color       TEXT,
    timezone    TEXT,
    components  TEXT NOT NULL DEFAULT 'VEVENT,VTODO,VJOURNAL',
    sort_order  INTEGER,
    sync_token  BIGINT NOT NULL DEFAULT 1,
    UNIQUE (user_id, type, uri)
  );

  CREATE TABLE objects (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id    INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    uri              TEXT NOT NULL,
    data             TEXT NOT NULL,
    etag             TEXT NOT NULL,
    size             INTEGER NOT NULL,
    component_type   TEXT NOT NULL,
    uid              TEXT,
    first_occurrence BIGINT,
    last_occurrence  BIGINT,
    last_modified    BIGINT NOT NULL,
    UNIQUE (collection_id, uri)
  );
  CREATE INDEX objects_uid ON objects (collection_id, uid);
  CREATE INDEX objects_range ON objects (collection_id, component_type, last_occurrence);

  -- operation: 1 = added, 2 = modified, 3 = deleted
  CREATE TABLE changes (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    uri           TEXT NOT NULL,
    sync_token    BIGINT NOT NULL,
    operation     SMALLINT NOT NULL
  );
  CREATE INDEX changes_sync ON changes (collection_id, sync_token);
  `,
  // 2: WebDAV locks (RFC 4918) and dead properties, keyed by the resource path inside the owner's tree.
  `
  CREATE TABLE locks (
    token        TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    depth        SMALLINT NOT NULL,
    exclusive    BOOLEAN NOT NULL,
    owner        TEXT,
    timeout_secs INTEGER NOT NULL,
    expires_at   BIGINT NOT NULL
  );
  CREATE INDEX locks_user ON locks (user_id);
  CREATE TABLE dead_props (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    name    TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, path, name)
  );
  `,
];

const COLLECTION_FIELDS = ['displayname', 'description', 'color', 'timezone', 'components', 'sort_order'];

// BIGINT columns only hold epoch seconds and counters, which are far below 2^53.
const types = {
  getTypeParser: (oid, format) => (oid === PG_INT8 ? Number : pg.types.getTypeParser(oid, format)),
};

const toInt = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * PostgreSQL-backed storage. Obtain an instance with Store.open(); inside Store#transaction the callback
 * receives a transaction-bound Store, which must be used for every statement that belongs to the transaction.
 */
export class Store {
  #db;
  #pool;
  #inTransaction;

  constructor(db, pool, inTransaction = false) {
    this.#db = db;
    this.#pool = pool;
    this.#inTransaction = inTransaction;
  }

  static async open(connectionString, { schema = null, poolSize = 10 } = {}) {
    if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      max: poolSize,
      types,
      options: schema ? `-c search_path=${schema}` : undefined,
    });
    pool.on('error', (err) => console.error('postgres pool error:', err.message));
    const store = new Store(pool, pool);
    try {
      if (schema) await store.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await store.#migrate();
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    return store;
  }

  async #migrate() {
    await this.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await tx.query('CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL)');
      const [row] = await tx.query('SELECT version FROM schema_info');
      const current = row?.version ?? 0;
      if (current > SCHEMA_VERSION) throw new Error(`Database schema version ${current} is newer than this server supports`);
      for (let v = current; v < SCHEMA_VERSION; v++) await tx.query(MIGRATIONS[v]);
      if (!row) await tx.query('INSERT INTO schema_info (version) VALUES ($1)', [SCHEMA_VERSION]);
      else if (current !== SCHEMA_VERSION) await tx.query('UPDATE schema_info SET version = $1', [SCHEMA_VERSION]);
    });
  }

  async close() {
    await this.#pool.end();
  }

  /** Runs a statement and returns its rows. */
  async query(sql, params = []) {
    return (await this.#db.query(sql, params)).rows;
  }

  async #one(sql, params) {
    return (await this.query(sql, params))[0] ?? null;
  }

  /** Runs fn in a transaction (joins the current one if already inside); rolls back if fn throws. */
  async transaction(fn) {
    if (this.#inTransaction) return fn(this);
    const client = await this.#pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      const result = await fn(new Store(client, this.#pool, true));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    } finally {
      client.release(releaseError);
    }
  }

  // ---- users -------------------------------------------------------------

  async createUser({ username, passwordHash, displayName, email = null, isAdmin = false }) {
    const name = username.toLowerCase();
    return this.transaction(async (tx) => {
      const user = await tx.#one(
        `INSERT INTO users (username, password_hash, display_name, email, is_admin, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, passwordHash, displayName ?? name, email, isAdmin, Math.floor(Date.now() / 1000)],
      );
      await tx.createCollection(user.id, 'calendar', 'default', { displayname: 'Default calendar' });
      await tx.createCollection(user.id, 'addressbook', 'default', { displayname: 'Default address book' });
      return user;
    });
  }

  getUserByName(username) {
    return this.#one('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  }

  getUserById(id) {
    return this.#one('SELECT * FROM users WHERE id = $1', [id]);
  }

  getUserByEmail(email) {
    return this.#one('SELECT * FROM users WHERE lower(email) = lower($1) ORDER BY id LIMIT 1', [email]);
  }

  listUsers() {
    return this.query('SELECT id, username, display_name, email, is_admin FROM users ORDER BY username');
  }

  async countUsers() {
    return Number((await this.#one('SELECT COUNT(*) AS n FROM users', [])).n);
  }

  listUsersWithStats() {
    return this.query(
      `SELECT u.id, u.username, u.display_name, u.email, u.is_admin, u.created_at,
              COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'calendar') AS calendars,
              COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'addressbook') AS addressbooks
         FROM users u LEFT JOIN collections c ON c.user_id = u.id
        GROUP BY u.id ORDER BY u.username`,
    );
  }

  listCollectionsWithCounts(userId) {
    return this.query(
      `SELECT c.*, (SELECT COUNT(*) FROM objects o WHERE o.collection_id = c.id) AS object_count
         FROM collections c WHERE c.user_id = $1 ORDER BY c.type, c.uri`,
      [userId],
    );
  }

  /** Locks every admin row until the transaction ends and returns their ids. */
  async lockAdmins() {
    return (await this.query('SELECT id FROM users WHERE is_admin ORDER BY id FOR UPDATE')).map((r) => r.id);
  }

  async updateUser(id, { passwordHash, displayName, email, isAdmin }) {
    const sets = [];
    const args = [];
    const add = (column, value) => { args.push(value); sets.push(`${column} = $${args.length}`); };
    if (passwordHash !== undefined) add('password_hash', passwordHash);
    if (displayName !== undefined) add('display_name', displayName);
    if (email !== undefined) add('email', email);
    if (isAdmin !== undefined) add('is_admin', isAdmin);
    if (!sets.length) return;
    args.push(id);
    await this.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  }

  async deleteUser(id) {
    return (await this.#db.query('DELETE FROM users WHERE id = $1', [id])).rowCount > 0;
  }

  // ---- collections -------------------------------------------------------

  listCollections(userId, type) {
    return this.query('SELECT * FROM collections WHERE user_id = $1 AND type = $2 ORDER BY sort_order, uri', [userId, type]);
  }

  getCollection(userId, type, uri) {
    return this.#one('SELECT * FROM collections WHERE user_id = $1 AND type = $2 AND uri = $3', [userId, type, uri]);
  }

  getCollectionById(id) {
    return this.#one('SELECT * FROM collections WHERE id = $1', [id]);
  }

  createCollection(userId, type, uri, props = {}) {
    return this.#one(
      `INSERT INTO collections (user_id, type, uri, displayname, description, color, timezone, components, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        userId, type, uri,
        props.displayname ?? uri, props.description ?? null, props.color ?? null, props.timezone ?? null,
        props.components ?? 'VEVENT,VTODO,VJOURNAL', props.sort_order ?? null,
      ],
    );
  }

  async updateCollection(id, props) {
    const keys = Object.keys(props).filter((k) => COLLECTION_FIELDS.includes(k));
    if (!keys.length) return;
    await this.query(
      `UPDATE collections SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => props[k]), id],
    );
  }

  async deleteCollection(id) {
    return (await this.#db.query('DELETE FROM collections WHERE id = $1', [id])).rowCount > 0;
  }

  async renameCollection(id, uri) {
    await this.query('UPDATE collections SET uri = $1 WHERE id = $2', [uri, id]);
  }

  /** Serialises writers of one collection until the surrounding transaction ends. Returns false if it no longer exists. */
  async lockCollection(id) {
    return (await this.#one('SELECT id FROM collections WHERE id = $1 FOR UPDATE', [id])) !== null;
  }

  // ---- objects -----------------------------------------------------------

  listObjects(collectionId, { withData = false, componentType = null, rangeStart = null, rangeEnd = null } = {}) {
    const cols = `uri, etag, size, component_type, uid, last_modified${withData ? ', data' : ''}`;
    const args = [collectionId];
    let sql = `SELECT ${cols} FROM objects WHERE collection_id = $1`;
    const add = (clause, value) => { args.push(value); sql += ` AND ${clause.replace('?', `$${args.length}`)}`; };
    if (componentType) add('component_type = ?', componentType);
    if (rangeEnd != null) add('(first_occurrence IS NULL OR first_occurrence <= ?)', Math.ceil(rangeEnd / 1000));
    if (rangeStart != null) add('(last_occurrence IS NULL OR last_occurrence >= ?)', Math.floor(rangeStart / 1000));
    return this.query(`${sql} ORDER BY uri`, args);
  }

  getObject(collectionId, uri) {
    return this.#one('SELECT * FROM objects WHERE collection_id = $1 AND uri = $2', [collectionId, uri]);
  }

  getObjects(collectionId, uris) {
    if (!uris.length) return [];
    return this.query('SELECT * FROM objects WHERE collection_id = $1 AND uri = ANY($2::text[])', [collectionId, uris]);
  }

  findByUid(collectionId, uid) {
    return this.#one('SELECT uri FROM objects WHERE collection_id = $1 AND uid = $2 LIMIT 1', [collectionId, uid]);
  }

  async putObject(collection, uri, data, meta) {
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 32);
    const now = Math.floor(Date.now() / 1000);
    const values = [data, etag, Buffer.byteLength(data), meta.componentType, meta.uid, toInt(meta.firstOccurrence), toInt(meta.lastOccurrence), now];
    return this.transaction(async (tx) => {
      if (!(await tx.lockCollection(collection.id))) return null;
      const existing = await tx.#one('SELECT id FROM objects WHERE collection_id = $1 AND uri = $2', [collection.id, uri]);
      if (existing) {
        await tx.query(
          `UPDATE objects SET data = $1, etag = $2, size = $3, component_type = $4, uid = $5,
             first_occurrence = $6, last_occurrence = $7, last_modified = $8 WHERE id = $9`,
          [...values, existing.id],
        );
      } else {
        await tx.query(
          `INSERT INTO objects (data, etag, size, component_type, uid, first_occurrence, last_occurrence, last_modified, collection_id, uri)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [...values, collection.id, uri],
        );
      }
      await tx.#recordChange(collection.id, uri, existing ? OP.MODIFIED : OP.ADDED);
      return { created: !existing, etag };
    });
  }

  async deleteObject(collectionId, uri) {
    return this.transaction(async (tx) => {
      if (!(await tx.lockCollection(collectionId))) return false;
      const { rowCount } = await tx.#db.query('DELETE FROM objects WHERE collection_id = $1 AND uri = $2', [collectionId, uri]);
      if (rowCount) await tx.#recordChange(collectionId, uri, OP.DELETED);
      return rowCount > 0;
    });
  }

  // ---- locks, dead properties, usage -------------------------------------

  async createLock({ token, userId, path, depth, exclusive, owner = null, timeout }) {
    await this.query('DELETE FROM locks WHERE expires_at <= $1', [Math.floor(Date.now() / 1000)]);
    return this.#one(
      `INSERT INTO locks (token, user_id, path, depth, exclusive, owner, timeout_secs, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [token, userId, path, depth, exclusive, owner, timeout, Math.floor(Date.now() / 1000) + timeout],
    );
  }

  listLocks(userId) {
    return this.query('SELECT * FROM locks WHERE user_id = $1 AND expires_at > $2 ORDER BY token', [userId, Math.floor(Date.now() / 1000)]);
  }

  refreshLock(token, timeout) {
    return this.#one(
      'UPDATE locks SET timeout_secs = $2, expires_at = $3 WHERE token = $1 RETURNING *',
      [token, timeout, Math.floor(Date.now() / 1000) + timeout],
    );
  }

  async deleteLock(token) {
    return (await this.#db.query('DELETE FROM locks WHERE token = $1', [token])).rowCount > 0;
  }

  /** Forgets locks and dead properties of a resource and everything beneath it. */
  async deletePathState(userId, path) {
    const where = 'user_id = $1 AND (path = $2 OR starts_with(path, $2 || \'/\'))';
    await this.query(`DELETE FROM locks WHERE ${where}`, [userId, path]);
    await this.query(`DELETE FROM dead_props WHERE ${where}`, [userId, path]);
  }

  listDeadProps(userId, path) {
    return this.query(
      'SELECT path, name, value FROM dead_props WHERE user_id = $1 AND (path = $2 OR starts_with(path, $2 || \'/\'))',
      [userId, path],
    );
  }

  async setDeadProps(userId, path, sets, removes) {
    for (const { name, value } of sets) {
      await this.query(
        `INSERT INTO dead_props (user_id, path, name, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, path, name) DO UPDATE SET value = EXCLUDED.value`,
        [userId, path, name, value],
      );
    }
    if (removes.length) await this.query('DELETE FROM dead_props WHERE user_id = $1 AND path = $2 AND name = ANY($3::text[])', [userId, path, removes]);
  }

  async copyDeadProps(userId, from, to) {
    await this.query(
      `INSERT INTO dead_props (user_id, path, name, value)
       SELECT user_id, $3 || substr(path, length($2) + 1), name, value FROM dead_props
        WHERE user_id = $1 AND (path = $2 OR starts_with(path, $2 || '/'))
       ON CONFLICT (user_id, path, name) DO UPDATE SET value = EXCLUDED.value`,
      [userId, from, to],
    );
  }

  /** Total stored bytes of a user, or of one collection. */
  async usedBytes({ userId, collectionId }) {
    const [row] = collectionId != null
      ? await this.query('SELECT COALESCE(SUM(size), 0) AS n FROM objects WHERE collection_id = $1', [collectionId])
      : await this.query('SELECT COALESCE(SUM(o.size), 0) AS n FROM objects o JOIN collections c ON c.id = o.collection_id WHERE c.user_id = $1', [userId]);
    return Number(row.n);
  }

  async collectionUsage(userId) {
    const rows = await this.query(
      'SELECT c.id, COALESCE(SUM(o.size), 0) AS n FROM collections c LEFT JOIN objects o ON o.collection_id = c.id WHERE c.user_id = $1 GROUP BY c.id',
      [userId],
    );
    return new Map(rows.map((row) => [row.id, Number(row.n)]));
  }

  // Changes are logged with the collection's current token, which is then bumped.
  async #recordChange(collectionId, uri, operation) {
    const { token } = await this.#one(
      'UPDATE collections SET sync_token = sync_token + 1 WHERE id = $1 RETURNING sync_token - 1 AS token',
      [collectionId],
    );
    await this.query('INSERT INTO changes (collection_id, uri, sync_token, operation) VALUES ($1, $2, $3, $4)', [collectionId, uri, token, operation]);
  }

  /** Latest operation per URI for every change recorded at or after `token`. */
  changesSince(collectionId, token) {
    return this.query(
      `SELECT c.uri, c.operation FROM changes c
         JOIN (SELECT MAX(id) AS id FROM changes WHERE collection_id = $1 AND sync_token >= $2 GROUP BY uri) latest
           ON c.id = latest.id
        ORDER BY c.id`,
      [collectionId, token],
    );
  }
}
