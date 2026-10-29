// Admin UI against the real PostgreSQL store, together with the DAV endpoint it manages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const skip = process.env.TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (PostgreSQL)';
const form = (fields) => ({ 'Content-Type': 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString() });

test('admin UI creates a user who can use DAV, and deleting revokes access', { skip }, async (t) => {
  const s = await startServer({ SESSION_SECRET: 'integration-test-secret' });
  t.after(s.close);
  await s.store.updateUser((await s.store.getUserByName('alice')).id, { isAdmin: true });

  const fetchAdmin = (method, path, { cookie, fields } = {}) => {
    const f = fields && form(fields);
    return fetch(s.origin + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(f ? { 'Content-Type': f['Content-Type'] } : {}) }, body: f?.body });
  };
  const login = await fetchAdmin('POST', '/admin/login', { fields: { username: 'alice', password: 'alice-password' } });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetchAdmin('GET', '/admin/users/new', { cookie })).text())[1];

  const created = await fetchAdmin('POST', '/admin/users', {
    cookie, fields: { _csrf: csrf, username: 'carol', password: 'carol-password', confirm: 'carol-password' },
  });
  assert.equal(created.status, 303);

  const list = await (await fetchAdmin('GET', '/admin/', { cookie })).text();
  assert.match(list, /carol/);
  const stats = (await s.store.listUsersWithStats()).find((u) => u.username === 'carol');
  assert.deepEqual([stats.calendars, stats.addressbooks], [1, 1]);

  const carolAuth = `Basic ${Buffer.from('carol:carol-password').toString('base64')}`;
  const dav = () => s.request('PROPFIND', '/dav/calendars/carol/', { auth: false, headers: { Authorization: carolAuth, Depth: '1' } });
  assert.equal((await dav()).status, 207);

  const id = (await s.store.getUserByName('carol')).id;
  const del = await fetchAdmin('POST', `/admin/users/${id}/delete`, { cookie, fields: { _csrf: csrf } });
  assert.equal(del.status, 303);
  assert.equal((await dav()).status, 401);
  assert.equal((await s.store.query('SELECT 1 FROM collections WHERE user_id = $1', [id])).length, 0, 'collections cascade');
});

test('concurrent demotions cannot remove the last administrator', { skip }, async (t) => {
  const s = await startServer({ SESSION_SECRET: 'integration-test-secret' });
  t.after(s.close);
  const [alice, bob] = await Promise.all(['alice', 'bob'].map((n) => s.store.getUserByName(n)));
  await Promise.all([alice, bob].map((u) => s.store.updateUser(u.id, { isAdmin: true })));

  const session = async (name) => {
    const res = await fetch(`${s.origin}/admin/login`, { method: 'POST', redirect: 'manual', ...form({ username: name, password: `${name}-password` }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${s.origin}/admin/account`, { headers: { Cookie: cookie } })).text();
    return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(html)[1] };
  };
  const [a, b] = await Promise.all([session('alice'), session('bob')]);
  const demote = (who, target) => fetch(`${s.origin}/admin/users/${target.id}`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: who.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: who.csrf, display_name: target.username }).toString(),
  });
  await Promise.all([demote(a, bob), demote(b, alice)]);
  const admins = await s.store.lockAdmins();
  assert.ok(admins.length >= 1, 'at least one admin must remain');
});
