import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './errors.js';

const scryptAsync = promisify(scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
  return timingSafeEqual(key, expected);
}

const CACHE_TTL_MS = 60_000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;
let dummyHash;

/** HTTP Basic authentication against the user table, with a verified-credential cache and per-IP brute-force limiting. */
export class Authenticator {
  constructor(store, { realm, trustProxy }) {
    this.store = store;
    this.realm = realm;
    this.trustProxy = trustProxy;
    this.cache = new Map();
    this.failures = new Map();
  }

  challenge() {
    return new HttpError(401, 'Unauthorized', {
      headers: { 'WWW-Authenticate': `Basic realm="${this.realm}", charset="UTF-8"` },
    });
  }

  clientIp(req) {
    if (this.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return xff.split(',').at(-1).trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** Returns the user row, or null when no / bad credentials were supplied. */
  async authenticate(req) {
    const header = req.headers.authorization;
    const m = header && /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!m) return null;

    const key = createHash('sha256').update(header).digest('hex');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) {
      const user = await this.store.getUserById(hit.userId);
      // Comparing the stored hash makes password changes and deletions effective immediately.
      if (user && user.password_hash === hit.passwordHash) return user;
      this.cache.delete(key);
    }

    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    const user = await this.verifyLogin(decoded.slice(0, sep), decoded.slice(sep + 1), this.clientIp(req));
    if (!user) return null;

    if (this.cache.size >= 1000) this.#prune(now);
    this.cache.set(key, { userId: user.id, passwordHash: user.password_hash, expires: now + CACHE_TTL_MS });
    return user;
  }

  /** Checks a username/password pair with per-IP throttling. Returns the user row or null; throws 429 when throttled. */
  async verifyLogin(username, password, ip) {
    const now = Date.now();
    const failure = this.failures.get(ip);
    if (failure && failure.resetAt > now && failure.count >= MAX_FAILURES) {
      throw new HttpError(429, 'Too many failed login attempts', {
        headers: { 'Retry-After': String(Math.ceil((failure.resetAt - now) / 1000)) },
      });
    }

    // PostgreSQL text cannot hold NUL, so such names cannot exist and must not reach the query.
    const lookup = username.length > 256 || username.includes('\0') ? null : await this.store.getUserByName(username);

    // Always run a scrypt verification so unknown usernames cost the same as wrong passwords.
    dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
    const valid = await verifyPassword(password, lookup ? lookup.password_hash : dummyHash);
    if (!lookup || !valid) {
      this.#recordFailure(ip, now);
      return null;
    }

    this.failures.delete(ip);
    return lookup;
  }

  #recordFailure(ip, now) {
    if (this.failures.size >= 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
    const cur = this.failures.get(ip);
    if (cur && cur.resetAt > now) cur.count++;
    else this.failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  }

  #prune(now) {
    for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    if (this.cache.size >= 1000) this.cache.clear();
  }
}
