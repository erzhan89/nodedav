// Admin UI tests. They run against an in-memory store, so they need neither PostgreSQL nor the pg driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { Authenticator, hashPassword, verifyPassword } from '../src/auth.js';
import { createAdminHandler } from '../src/admin.js';
import { Sessions } from '../src/session.js';
import { html, raw, toString } from '../src/html.js';

class MemoryStore {
  users = new Map();
  nextId = 1;

  async add(username, password, { admin = false } = {}) {
    return this.createUser({ username, passwordHash: await hashPassword(password), isAdmin: admin });
  }

  async createUser({ username, passwordHash, displayName, email = null, isAdmin = false }) {
    const name = username.toLowerCase();
    if ([...this.users.values()].some((u) => u.username === name)) throw Object.assign(new Error('duplicate'), { code: '23505' });
    const user = {
      id: this.nextId++, username: name, password_hash: passwordHash, display_name: displayName ?? name,
      email, is_admin: isAdmin, created_at: 1_700_000_000,
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUserById(id) { return this.users.get(id) ?? null; }
  async getUserByName(name) { return [...this.users.values()].find((u) => u.username === name.toLowerCase()) ?? null; }
  async transaction(fn) { return fn(this); }
  async lockAdmins() { return [...this.users.values()].filter((u) => u.is_admin).map((u) => u.id); }
  async deleteUser(id) { return this.users.delete(id); }
  async listCollectionsWithCounts() { return [{ type: 'calendar', uri: 'default', displayname: 'Default calendar', object_count: 0 }]; }
  async listUsersWithStats() {
    return [...this.users.values()].map((u) => ({ ...u, calendars: 1, addressbooks: 1 })).sort((a, b) => a.username.localeCompare(b.username));
  }

  async updateUser(id, { passwordHash, displayName, email, isAdmin }) {
    const u = this.users.get(id);
    if (passwordHash !== undefined) u.password_hash = passwordHash;
    if (displayName !== undefined) u.display_name = displayName;
    if (email !== undefined) u.email = email;
    if (isAdmin !== undefined) u.is_admin = isAdmin;
  }
}

async function start(env = {}) {
  const config = loadConfig({ LOG_REQUESTS: 'false', SESSION_SECRET: 'a-test-secret-of-sufficient-length', ...env });
  const store = new MemoryStore();
  await store.add('alice', 'alice-password', { admin: true });
  await store.add('bob', 'bob-password');
  const auth = new Authenticator(store, { realm: 'nodedav', trustProxy: false });
  const admin = createAdminHandler({ store, config, auth });
  const server = createServer((req, res) => admin.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const request = (method, path, { cookie, form, headers = {} } = {}) => fetch(origin + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
  const login = async (username, password) => {
    const res = await request('POST', '/admin/login', { form: { username, password } });
    assert.equal(res.status, 303, `login as ${username}`);
    return cookieOf(res);
  };
  const csrfOf = async (cookie, path = '/admin/account') => {
    const body = await (await request('GET', path, { cookie })).text();
    return /name="_csrf" value="([^"]+)"/.exec(body)[1];
  };
  // POST with a valid CSRF token taken from `from`.
  const post = async (cookie, path, form, from) => request('POST', path, { cookie, form: { _csrf: await csrfOf(cookie, from), ...form } });

  return {
    store, request, login, csrfOf, post, cookieOf,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('anonymous visitors are sent to the login page; static CSS is public', async (t) => {
  const s = await start();
  t.after(s.close);
  const res = await s.request('GET', '/admin/');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');
  const login = await s.request('GET', '/admin/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(login.headers.get('x-frame-options'), 'DENY');
  const css = await s.request('GET', '/admin/static/admin.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('login: wrong password is refused, right password sets a hardened cookie', async (t) => {
  const s = await start();
  t.after(s.close);
  const bad = await s.request('POST', '/admin/login', { form: { username: 'alice', password: 'nope' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('set-cookie'), null);
  const unknown = await s.request('POST', '/admin/login', { form: { username: 'nobody\0', password: 'x' } });
  assert.equal(unknown.status, 403);

  const ok = await s.request('POST', '/admin/login', { form: { username: 'Alice', password: 'alice-password' } });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^nodedav_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/admin/);
  const page = await s.request('GET', '/admin/', { cookie: s.cookieOf(ok) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /alice/);
});

test('login is throttled per client IP', async (t) => {
  const s = await start();
  t.after(s.close);
  for (let i = 0; i < 10; i++) {
    assert.equal((await s.request('POST', '/admin/login', { form: { username: 'alice', password: 'wrong' } })).status, 403);
  }
  const blocked = await s.request('POST', '/admin/login', { form: { username: 'alice', password: 'alice-password' } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
});

test('state-changing requests need a CSRF token and a same-origin browser context', async (t) => {
  const s = await start();
  t.after(s.close);
  const cookie = await s.login('alice', 'alice-password');
  const form = { username: 'carol', password: 'carol-password', confirm: 'carol-password' };

  assert.equal((await s.request('POST', '/admin/users', { cookie, form })).status, 403);
  assert.equal((await s.request('POST', '/admin/users', { cookie, form: { ...form, _csrf: 'forged' } })).status, 403);

  const csrf = await s.csrfOf(cookie);
  const crossSite = await s.request('POST', '/admin/users', { cookie, form: { ...form, _csrf: csrf }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const foreignOrigin = await s.request('POST', '/admin/users', { cookie, form: { ...form, _csrf: csrf }, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(await s.store.getUserByName('carol'), null);

  const json = await s.request('POST', '/admin/users', { cookie, headers: { 'Content-Type': 'application/json' } });
  assert.equal(json.status, 415);
  const logoutGet = await s.request('GET', '/admin/logout', { cookie });
  assert.equal(logoutGet.status, 405);
});

test('a CSRF token from another session is rejected', async (t) => {
  const s = await start();
  t.after(s.close);
  const alice = await s.login('alice', 'alice-password');
  const bob = await s.login('bob', 'bob-password');
  const bobsToken = await s.csrfOf(bob);
  const res = await s.request('POST', '/admin/users', { cookie: alice, form: { _csrf: bobsToken, username: 'x1', password: 'password-1', confirm: 'password-1' } });
  assert.equal(res.status, 403);
});

test('non-admins only reach their account page', async (t) => {
  const s = await start();
  t.after(s.close);
  const cookie = await s.login('bob', 'bob-password');
  const home = await s.request('GET', '/admin/', { cookie });
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/admin/account');
  assert.equal((await s.request('GET', '/admin/users/new', { cookie })).status, 403);
  assert.equal((await s.request('GET', '/admin/users/1', { cookie })).status, 403);
  const created = await s.post(cookie, '/admin/users', { username: 'eve', password: 'eve-password', confirm: 'eve-password' });
  assert.equal(created.status, 403);
  assert.equal(await s.store.getUserByName('eve'), null);
  const account = await s.request('GET', '/admin/account', { cookie });
  assert.equal(account.status, 200);
  assert.match(await account.text(), /Add CalDAV Account/);
});

test('admin creates users with validation, and output is escaped', async (t) => {
  const s = await start();
  t.after(s.close);
  const cookie = await s.login('alice', 'alice-password');

  const short = await s.post(cookie, '/admin/users', { username: 'carol', password: 'short', confirm: 'short' });
  assert.equal(short.status, 400);
  assert.match(await short.text(), /at least 8 characters/);
  const mismatch = await s.post(cookie, '/admin/users', { username: 'carol', password: 'carol-password', confirm: 'different' });
  assert.match(await mismatch.text(), /do not match/);
  const badName = await s.post(cookie, '/admin/users', { username: 'a b', password: 'carol-password', confirm: 'carol-password' });
  assert.equal(badName.status, 400);
  const dup = await s.post(cookie, '/admin/users', { username: 'BOB', password: 'carol-password', confirm: 'carol-password' });
  assert.match(await dup.text(), /already taken/);
  assert.equal(s.store.users.size, 2);

  const ok = await s.post(cookie, '/admin/users', {
    username: 'Carol', display_name: '<script>alert(1)</script>', email: 'carol@example.com', password: 'carol-password', confirm: 'carol-password', is_admin: 'on',
  });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /^\/admin\/users\/\d+\?ok=created$/);
  const carol = await s.store.getUserByName('carol');
  assert.equal(carol.is_admin, true);
  assert.ok(await verifyPassword('carol-password', carol.password_hash));

  const list = await (await s.request('GET', '/admin/', { cookie })).text();
  assert.ok(!list.includes('<script>alert'));
  assert.match(list, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // Unknown flash codes are never reflected.
  const flash = await (await s.request('GET', '/admin/?ok=%3Cb%3Ehi', { cookie })).text();
  assert.ok(!flash.includes('<b>hi'));
});

test('admin edits users; an admin cannot demote or delete themselves', async (t) => {
  const s = await start();
  t.after(s.close);
  const cookie = await s.login('alice', 'alice-password');
  const alice = await s.store.getUserByName('alice');
  const bob = await s.store.getUserByName('bob');

  const promote = await s.post(cookie, `/admin/users/${bob.id}`, { display_name: 'Bobby', email: 'bob@example.com', is_admin: 'on' }, `/admin/users/${bob.id}`);
  assert.equal(promote.status, 303);
  assert.deepEqual([bob.display_name, bob.email, bob.is_admin], ['Bobby', 'bob@example.com', true]);

  const self = await s.post(cookie, `/admin/users/${alice.id}`, { display_name: 'Alice' }, `/admin/users/${alice.id}`);
  assert.equal(self.status, 303);
  assert.equal(alice.is_admin, true, 'checkbox absent on self must not demote');

  const badEmail = await s.post(cookie, `/admin/users/${bob.id}`, { display_name: 'Bob', email: 'not-an-email' }, `/admin/users/${bob.id}`);
  assert.equal(badEmail.status, 400);

  assert.equal((await s.request('GET', `/admin/users/${alice.id}/delete`, { cookie })).status, 403);
  const selfDelete = await s.post(cookie, `/admin/users/${alice.id}/delete`, {}, `/admin/users/${bob.id}`);
  assert.equal(selfDelete.status, 403);
  assert.ok(await s.store.getUserById(alice.id));

  assert.equal((await s.request('GET', '/admin/users/999', { cookie })).status, 404);
  assert.equal((await s.request('GET', '/admin/users/abc', { cookie })).status, 404);
});

test('deleting a user removes them and their login stops working', async (t) => {
  const s = await start();
  t.after(s.close);
  const admin = await s.login('alice', 'alice-password');
  const bobCookie = await s.login('bob', 'bob-password');
  const bob = await s.store.getUserByName('bob');

  const confirmPage = await s.request('GET', `/admin/users/${bob.id}/delete`, { cookie: admin });
  assert.equal(confirmPage.status, 200);
  const res = await s.post(admin, `/admin/users/${bob.id}/delete`, {}, `/admin/users/${bob.id}/delete`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/?ok=deleted');
  assert.equal(await s.store.getUserByName('bob'), null);
  // The deleted user's session no longer works.
  const after = await s.request('GET', '/admin/account', { cookie: bobCookie });
  assert.equal(after.headers.get('location'), '/admin/login');
  const again = await s.post(admin, `/admin/users/${bob.id}/delete`, {}, '/admin/');
  assert.equal(again.status, 404);
});

test('changing the password needs the current one, keeps you signed in and ends old sessions', async (t) => {
  const s = await start();
  t.after(s.close);
  const first = await s.login('bob', 'bob-password');
  const other = await s.login('bob', 'bob-password');

  const wrong = await s.post(first, '/admin/account', { current: 'bad', password: 'new-password-1', confirm: 'new-password-1' });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /Current password is incorrect/);

  const res = await s.post(first, '/admin/account', { current: 'bob-password', password: 'new-password-1', confirm: 'new-password-1' });
  assert.equal(res.status, 303);
  const fresh = s.cookieOf(res);
  assert.equal((await s.request('GET', '/admin/account', { cookie: fresh })).status, 200);
  assert.equal((await s.request('GET', '/admin/account', { cookie: first })).status, 303);
  assert.equal((await s.request('GET', '/admin/account', { cookie: other })).status, 303);
  const bob = await s.store.getUserByName('bob');
  assert.ok(await verifyPassword('new-password-1', bob.password_hash));
  assert.ok(!(await verifyPassword('bob-password', bob.password_hash)));
});

test('logout clears the cookie; tampered cookies are rejected', async (t) => {
  const s = await start();
  t.after(s.close);
  const cookie = await s.login('alice', 'alice-password');
  const out = await s.post(cookie, '/admin/logout', {});
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${value.slice(0, -2)}AA`;
  assert.equal((await s.request('GET', '/admin/', { cookie: tampered })).status, 303);
  assert.equal((await s.request('GET', '/admin/', { cookie: `${name}=garbage` })).status, 303);
});

test('unsupported methods and oversized forms', async (t) => {
  const s = await start();
  t.after(s.close);
  assert.equal((await s.request('PUT', '/admin/')).status, 405);
  const big = await s.request('POST', '/admin/login', { form: { username: 'a', password: 'x'.repeat(40_000) } });
  assert.equal(big.status, 413);
});

test('config: admin path rules', () => {
  assert.equal(loadConfig({}).adminPath, '/admin');
  assert.equal(loadConfig({ ADMIN_UI: 'false' }).adminPath, null);
  assert.equal(loadConfig({ ADMIN_PATH: 'manage/' }).adminPath, '/manage');
  assert.throws(() => loadConfig({ ADMIN_PATH: '/dav' }), /different from BASE_PATH/);
  assert.throws(() => loadConfig({ SESSION_SECRET: 'short' }), /at least 16/);
});

test('sessions: sign, expire, tamper, rotate with the password, csrf', async () => {
  const sessions = new Sessions('unit-test-secret-123');
  const user = { id: 7, password_hash: 'hash-a' };
  const now = 1_700_000_000_000;
  const value = sessions.issue(user, now);
  assert.deepEqual(sessions.parse(value, now + 1000)?.userId, 7);
  assert.equal(sessions.parse(value, now + 9 * 3600 * 1000), null, 'expired');
  assert.equal(sessions.parse(`${value}x`, now), null);
  assert.equal(sessions.parse(`${value.split('.')[0]}.${'A'.repeat(43)}`, now), null);
  assert.equal(new Sessions('another-secret-value-1').parse(value, now), null);
  assert.ok(sessions.matches(sessions.parse(value, now), user));
  assert.ok(!sessions.matches(sessions.parse(value, now), { ...user, password_hash: 'hash-b' }));
  assert.ok(sessions.checkCsrf(value, sessions.csrfToken(value)));
  assert.ok(!sessions.checkCsrf(value, sessions.csrfToken(`${value}x`)));
  assert.ok(!sessions.checkCsrf(value, undefined));
});

test('html: interpolations are escaped unless they come from html``/raw()', () => {
  const evil = `<img src=x onerror="a('b')">&`;
  assert.equal(toString(html`<p>${evil}</p>`), '<p>&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;</p>');
  assert.equal(toString(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(toString(html`${null}${false}${raw('<hr>')}`), '<hr>');
});
