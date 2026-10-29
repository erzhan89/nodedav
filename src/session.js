import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const fingerprint = (user) => createHash('sha256').update(user.password_hash).digest('hex').slice(0, 16);

/**
 * Stateless signed session cookies. A cookie carries the user id, a fingerprint of the password hash
 * (so changing the password signs everyone out) and an expiry. Without a configured secret a random one
 * is generated, which logs everybody out whenever the process restarts.
 */
export class Sessions {
  #key;
  #ttlMs;

  constructor(secret, { ttlSeconds = 8 * 3600 } = {}) {
    this.#key = secret ? createHash('sha256').update(`nodedav-session\0${secret}`).digest() : randomBytes(32);
    this.#ttlMs = ttlSeconds * 1000;
    this.maxAge = ttlSeconds;
  }

  #mac(data) {
    return createHmac('sha256', this.#key).update(data).digest();
  }

  issue(user, now = Date.now()) {
    const payload = `${user.id}.${fingerprint(user)}.${Math.floor((now + this.#ttlMs) / 1000)}`;
    return `${Buffer.from(payload).toString('base64url')}.${this.#mac(payload).toString('base64url')}`;
  }

  /** Returns { userId, fingerprint } for a genuine, unexpired cookie value, otherwise null. */
  parse(value, now = Date.now()) {
    if (typeof value !== 'string') return null;
    const [encoded, signature, extra] = value.split('.');
    if (!encoded || !signature || extra !== undefined) return null;
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const expected = this.#mac(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const [id, fp, exp] = payload.split('.');
    if (!/^\d+$/.test(id) || !/^[0-9a-f]{16}$/.test(fp ?? '') || !/^\d+$/.test(exp ?? '') || Number(exp) * 1000 <= now) return null;
    return { userId: Number(id), fingerprint: fp };
  }

  /** False once the user's password has changed since the cookie was issued. */
  matches(session, user) {
    return session.fingerprint === fingerprint(user);
  }

  csrfToken(cookieValue) {
    return this.#mac(`csrf:${cookieValue}`).toString('base64url');
  }

  checkCsrf(cookieValue, token) {
    if (typeof token !== 'string') return false;
    const expected = Buffer.from(this.csrfToken(cookieValue));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
