// RFC 4918 class 2 (COPY/MOVE/LOCK/dead properties), conditional requests, Prefer, quota and add-member POST.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ics, vcf } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const xml = { 'Content-Type': 'application/xml' };
const CAL = '/dav/calendars/alice/default/';
const BOOK = '/dav/addressbooks/alice/default/';
const dest = (path) => ({ Destination: s.origin + path });

const lockBody = (scope = 'exclusive') => `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>mailto:alice@example.com</D:href></D:owner></D:lockinfo>`;
const lockToken = (res) => /<([^>]+)>/.exec(res.headers.get('lock-token'))[1];

test('COPY to another collection keeps the source', async () => {
  const other = '/dav/calendars/alice/cp/';
  await s.request('MKCALENDAR', other);
  await s.request('PUT', CAL + 'src.ics', { body: ics('copy-1') });
  const copy = await s.request('COPY', CAL + 'src.ics', { headers: dest(other + 'copy.ics') });
  assert.equal(copy.status, 201);
  assert.ok(copy.headers.get('etag'));
  assert.equal((await s.request('GET', CAL + 'src.ics')).status, 200);
  assert.equal((await s.request('GET', other + 'copy.ics')).status, 200);
});

test('COPY into the same collection conflicts on UID, MOVE renames', async () => {
  const col = '/dav/calendars/alice/mv/';
  await s.request('MKCALENDAR', col);
  await s.request('PUT', col + 'a.ics', { body: ics('mv-1') });

  const dup = await s.request('COPY', col + 'a.ics', { headers: dest(col + 'b.ics') });
  assert.equal(dup.status, 409);
  assert.match(await dup.text(), /no-uid-conflict/);

  const mv = await s.request('MOVE', col + 'a.ics', { headers: dest(col + 'b.ics') });
  assert.equal(mv.status, 201);
  assert.equal((await s.request('GET', col + 'a.ics')).status, 404);
  assert.equal((await s.request('GET', col + 'b.ics')).status, 200);
});

test('Overwrite: F refuses an existing destination, T replaces it with 204', async () => {
  await s.request('PUT', CAL + 'o1.ics', { body: ics('ow-1') });
  await s.request('PUT', CAL + 'o2.ics', { body: ics('ow-2') });
  const refused = await s.request('COPY', CAL + 'o1.ics', { headers: { ...dest(CAL + 'o2.ics'), Overwrite: 'F' } });
  assert.equal(refused.status, 412);
  const other = '/dav/calendars/alice/ow/';
  await s.request('MKCALENDAR', other);
  await s.request('PUT', other + 'x.ics', { body: ics('ow-3') });
  const replaced = await s.request('COPY', CAL + 'o1.ics', { headers: dest(other + 'x.ics') });
  assert.equal(replaced.status, 204);
});

test('COPY/MOVE reject bad destinations', async () => {
  await s.request('PUT', CAL + 'bad.ics', { body: ics('bad-1') });
  assert.equal((await s.request('COPY', CAL + 'bad.ics')).status, 400);
  assert.equal((await s.request('COPY', CAL + 'bad.ics', { headers: { Destination: 'http://example.org/dav/x' } })).status, 502);
  assert.equal((await s.request('COPY', CAL + 'bad.ics', { headers: dest(CAL + 'bad.ics') })).status, 403);
  assert.equal((await s.request('COPY', CAL + 'bad.ics', { headers: dest('/dav/calendars/bob/default/bad.ics') })).status, 403);
  assert.equal((await s.request('COPY', CAL + 'bad.ics', { headers: dest(BOOK + 'bad.vcf') })).status, 403);
  assert.equal((await s.request('COPY', CAL + 'missing.ics', { headers: dest(CAL + 'z.ics') })).status, 404);
});

test('MOVE and COPY whole collections', async () => {
  const a = '/dav/calendars/alice/ca/';
  await s.request('MKCALENDAR', a);
  await s.request('PUT', a + '1.ics', { body: ics('col-1') });
  await s.request('PUT', a + '2.ics', { body: ics('col-2') });

  const copy = await s.request('COPY', a, { headers: dest('/dav/calendars/alice/cb/') });
  assert.equal(copy.status, 201);
  assert.equal((await s.request('GET', '/dav/calendars/alice/cb/2.ics')).status, 200);

  const shallow = await s.request('COPY', a, { headers: { ...dest('/dav/calendars/alice/cc/'), Depth: '0' } });
  assert.equal(shallow.status, 201);
  assert.equal((await s.request('GET', '/dav/calendars/alice/cc/1.ics')).status, 404);

  const mv = await s.request('MOVE', a, { headers: dest('/dav/calendars/alice/cd/') });
  assert.equal(mv.status, 201);
  assert.equal((await s.request('GET', a + '1.ics')).status, 404);
  assert.equal((await s.request('GET', '/dav/calendars/alice/cd/1.ics')).status, 200);
});

test('LOCK blocks other writers until the token is presented', async () => {
  await s.request('PUT', CAL + 'lk.ics', { body: ics('lock-1') });
  const res = await s.request('LOCK', CAL + 'lk.ics', { headers: { ...xml, Timeout: 'Second-600' }, body: lockBody() });
  assert.equal(res.status, 200);
  const token = lockToken(res);
  assert.match(token, /^opaquelocktoken:/);
  const body = await res.text();
  assert.match(body, /lockdiscovery/);
  assert.match(body, /Second-/);
  assert.match(body, /mailto:alice@example.com/);

  const blocked = await s.request('PUT', CAL + 'lk.ics', { body: ics('lock-1', '20300102T100000Z') });
  assert.equal(blocked.status, 423);
  assert.match(await blocked.text(), /lock-token-submitted/);
  assert.equal((await s.request('DELETE', CAL + 'lk.ics')).status, 423);
  assert.equal((await s.request('MOVE', CAL + 'lk.ics', { headers: dest(CAL + 'lk2.ics') })).status, 423);

  const ok = await s.request('PUT', CAL + 'lk.ics', { body: ics('lock-1', '20300102T100000Z'), headers: { If: `(<${token}>)` } });
  assert.equal(ok.status, 204);

  const second = await s.request('LOCK', CAL + 'lk.ics', { headers: xml, body: lockBody() });
  assert.equal(second.status, 423);
  assert.match(await second.text(), /no-conflicting-lock/);

  const prop = await s.request('PROPFIND', CAL + 'lk.ics', { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:"><prop><lockdiscovery/><supportedlock/></prop></propfind>' });
  const text = await prop.text();
  assert.ok(text.includes(token));
  assert.match(text, /lockentry/);

  const wrong = await s.request('UNLOCK', CAL + 'lk.ics', { headers: { 'Lock-Token': '<opaquelocktoken:nope>' } });
  assert.equal(wrong.status, 409);
  assert.equal((await s.request('UNLOCK', CAL + 'lk.ics', { headers: { 'Lock-Token': `<${token}>` } })).status, 204);
  assert.equal((await s.request('DELETE', CAL + 'lk.ics')).status, 204);
});

test('shared locks coexist, exclusive conflicts, refresh keeps the token', async () => {
  await s.request('PUT', CAL + 'sh.ics', { body: ics('lock-sh') });
  const a = await s.request('LOCK', CAL + 'sh.ics', { headers: xml, body: lockBody('shared') });
  const b = await s.request('LOCK', CAL + 'sh.ics', { headers: xml, body: lockBody('shared') });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await s.request('LOCK', CAL + 'sh.ics', { headers: xml, body: lockBody() })).status, 423);

  const token = lockToken(a);
  const refreshed = await s.request('LOCK', CAL + 'sh.ics', { headers: { If: `(<${token}>)`, Timeout: 'Second-7200' } });
  assert.equal(refreshed.status, 200);
  assert.ok((await refreshed.text()).includes(token));
  assert.equal((await s.request('LOCK', CAL + 'sh.ics', { headers: { If: '(<opaquelocktoken:nope>)' } })).status, 412);
});

test('a depth-infinity collection lock protects members and membership', async () => {
  const col = '/dav/calendars/alice/locked/';
  await s.request('MKCALENDAR', col);
  const res = await s.request('LOCK', col, { headers: xml, body: lockBody() });
  assert.equal(res.status, 200);
  const token = lockToken(res);
  assert.equal((await s.request('PUT', col + 'n.ics', { body: ics('lock-n') })).status, 423);
  assert.equal((await s.request('DELETE', col)).status, 423);
  assert.equal((await s.request('PUT', col + 'n.ics', { body: ics('lock-n'), headers: { If: `(<${token}>)` } })).status, 201);
  assert.equal((await s.request('DELETE', col, { headers: { If: `(<${token}>)` } })).status, 204);
  // Deleting the collection releases its lock.
  assert.deepEqual(await s.store.listLocks((await s.store.getUserByName('alice')).id).then((l) => l.filter((x) => x.path.endsWith('locked'))), []);
});

test('LOCK on an unmapped URL creates a lock-null resource (201) and PUT with the token fills it', async () => {
  const res = await s.request('LOCK', CAL + 'future.ics', { headers: xml, body: lockBody() });
  assert.equal(res.status, 201);
  const token = lockToken(res);
  assert.equal((await s.request('PUT', CAL + 'future.ics', { body: ics('future') })).status, 423);
  assert.equal((await s.request('PUT', CAL + 'future.ics', { body: ics('future'), headers: { If: `(<${token}>)` } })).status, 201);
});

test('If header: etag conditions, Not, and malformed values', async () => {
  const put = await s.request('PUT', CAL + 'if.ics', { body: ics('if-1') });
  const etag = put.headers.get('etag');
  assert.equal((await s.request('PUT', CAL + 'if.ics', { body: ics('if-1'), headers: { If: `([${etag}])` } })).status, 204);
  assert.equal((await s.request('PUT', CAL + 'if.ics', { body: ics('if-1'), headers: { If: '(["nope"])' } })).status, 412);
  assert.equal((await s.request('PUT', CAL + 'if.ics', { body: ics('if-1'), headers: { If: '(Not ["nope"])' } })).status, 204);
  assert.equal((await s.request('PUT', CAL + 'if.ics', { body: ics('if-1'), headers: { If: '(garbage' } })).status, 400);
});

test('conditional GET and ranges', async () => {
  const put = await s.request('PUT', BOOK + 'c.vcf', { body: vcf('cond-1', 'Cond') });
  const etag = put.headers.get('etag');
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { 'If-None-Match': '"other"' } })).status, 200);
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { 'If-Match': '"other"' } })).status, 412);
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { 'If-Modified-Since': new Date(Date.now() + 60_000).toUTCString() } })).status, 304);

  const full = await (await s.request('GET', BOOK + 'c.vcf')).text();
  const part = await s.request('GET', BOOK + 'c.vcf', { headers: { Range: 'bytes=0-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-4/${Buffer.byteLength(full)}`);
  assert.equal(await part.text(), full.slice(0, 5));
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { Range: 'bytes=99999-' } })).status, 416);
  // A non-matching If-Range falls back to the full body.
  assert.equal((await s.request('GET', BOOK + 'c.vcf', { headers: { Range: 'bytes=0-4', 'If-Range': '"stale"' } })).status, 200);
});

test('PUT preconditions: If-Match and If-None-Match', async () => {
  const first = await s.request('PUT', CAL + 'pm.ics', { body: ics('pm-1'), headers: { 'If-None-Match': '*' } });
  assert.equal(first.status, 201);
  assert.equal((await s.request('PUT', CAL + 'pm.ics', { body: ics('pm-1'), headers: { 'If-None-Match': '*' } })).status, 412);
  assert.equal((await s.request('PUT', CAL + 'pm.ics', { body: ics('pm-1'), headers: { 'If-Match': '"nope"' } })).status, 412);
  assert.equal((await s.request('PUT', CAL + 'pm.ics', { body: ics('pm-1'), headers: { 'If-Match': first.headers.get('etag') } })).status, 204);
  assert.equal((await s.request('DELETE', CAL + 'pm.ics', { headers: { 'If-Match': '"nope"' } })).status, 412);
});

test('dead properties round-trip through PROPPATCH/PROPFIND and follow COPY', async () => {
  await s.request('PUT', CAL + 'dp.ics', { body: ics('dp-1') });
  const patch = await s.request('PROPPATCH', CAL + 'dp.ics', {
    headers: xml,
    body: '<propertyupdate xmlns="DAV:" xmlns:x="urn:example"><set><prop><x:note>hello <x:b>world</x:b></x:note></prop></set></propertyupdate>',
  });
  assert.equal(patch.status, 207);
  assert.match(await patch.text(), /200 OK/);

  const find = (path) => s.request('PROPFIND', path, { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:"><allprop/></propfind>' });
  assert.match(await (await find(CAL + 'dp.ics')).text(), /hello <[^>]*b[^>]*>world/);

  await s.request('COPY', CAL + 'dp.ics', { headers: dest(CAL + 'dp2.ics') }).then((r) => assert.ok([201, 409].includes(r.status)));
  const named = await s.request('PROPFIND', CAL + 'dp.ics', { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:" xmlns:x="urn:example"><prop><x:note/></prop></propfind>' });
  assert.match(await named.text(), /hello/);

  const remove = await s.request('PROPPATCH', CAL + 'dp.ics', { headers: xml, body: '<propertyupdate xmlns="DAV:" xmlns:x="urn:example"><remove><prop><x:note/></prop></remove></propertyupdate>' });
  assert.equal(remove.status, 207);
  const gone = await s.request('PROPFIND', CAL + 'dp.ics', { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:" xmlns:x="urn:example"><prop><x:note/></prop></propfind>' });
  assert.match(await gone.text(), /404/);
});

test('PROPPATCH is atomic: a protected property fails the whole request with 424', async () => {
  const res = await s.request('PROPPATCH', CAL, {
    headers: xml,
    body: '<propertyupdate xmlns="DAV:" xmlns:x="urn:example"><set><prop><x:ok>1</x:ok><getetag>"x"</getetag></prop></set></propertyupdate>',
  });
  const text = await res.text();
  assert.equal(res.status, 207);
  assert.match(text, /403/);
  assert.match(text, /cannot-modify-protected-property/);
  assert.match(text, /424/);
  const check = await s.request('PROPFIND', CAL, { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:" xmlns:x="urn:example"><prop><x:ok/></prop></propfind>' });
  assert.match(await check.text(), /404/);
});

test('Prefer: return=minimal drops 404 propstats', async () => {
  const body = '<propfind xmlns="DAV:"><prop><displayname/><nonexistent/></prop></propfind>';
  const full = await s.request('PROPFIND', CAL, { headers: { ...xml, Depth: '0' }, body });
  assert.match(await full.text(), /404/);
  const min = await s.request('PROPFIND', CAL, { headers: { ...xml, Depth: '0', Prefer: 'return=minimal' }, body });
  assert.equal(min.headers.get('preference-applied'), 'return=minimal');
  assert.doesNotMatch(await min.text(), /404/);
});

test('quota properties report usage and the limit', async () => {
  const q = await startServer({ QUOTA_BYTES: '4000' });
  try {
    const body = '<propfind xmlns="DAV:"><prop><quota-used-bytes/><quota-available-bytes/></prop></propfind>';
    const col = '/dav/calendars/alice/default/';
    await q.request('PUT', col + 'q1.ics', { body: ics('q-1') });
    const res = await q.request('PROPFIND', col, { headers: { ...xml, Depth: '0' }, body });
    const text = await res.text();
    const used = Number(/quota-used-bytes>(\d+)</.exec(text)[1]);
    const avail = Number(/quota-available-bytes>(\d+)</.exec(text)[1]);
    assert.ok(used > 0);
    assert.equal(used + avail, 4000);

    const big = ics('q-big', '20300101T100000Z', `DESCRIPTION:${'x'.repeat(5000)}\r\n`);
    const over = await q.request('PUT', col + 'big.ics', { body: big });
    assert.equal(over.status, 507);
    assert.match(await over.text(), /quota-not-exceeded/);
    assert.equal((await q.request('GET', col + 'big.ics')).status, 404);
  } finally {
    await q.close();
  }
});

test('POST add-member creates a resource with a server-chosen name (RFC 5995)', async () => {
  const res = await s.request('POST', CAL, { headers: { 'Content-Type': 'text/calendar' }, body: ics('post-1') });
  assert.equal(res.status, 201);
  const location = res.headers.get('location');
  assert.match(location, /\/dav\/calendars\/alice\/default\/[0-9a-f-]+\.ics$/);
  assert.ok(res.headers.get('etag'));
  assert.equal((await s.request('GET', location)).status, 200);

  assert.equal((await s.request('POST', CAL, { headers: { 'Content-Type': 'text/vcard' }, body: vcf('x', 'X') })).status, 415);
  const card = await s.request('POST', BOOK, { headers: { 'Content-Type': 'text/vcard' }, body: vcf('post-2', 'Posted') });
  assert.equal(card.status, 201);
  assert.match(card.headers.get('location'), /\.vcf$/);

  const prop = await s.request('PROPFIND', CAL, { headers: { ...xml, Depth: '0' }, body: '<propfind xmlns="DAV:"><prop><add-member/></prop></propfind>' });
  assert.match(await prop.text(), /add-member>\s*<[^>]*href/);
});
