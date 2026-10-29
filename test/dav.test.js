import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ics, vcf } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const xml = { 'Content-Type': 'application/xml' };
const CAL = '/dav/calendars/alice/default/';
const BOOK = '/dav/addressbooks/alice/default/';

test('well-known redirects without auth', async () => {
  const res = await s.request('GET', '/.well-known/caldav', { auth: false });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/dav/');
});

test('OPTIONS needs no auth and advertises DAV classes', async () => {
  const res = await s.request('OPTIONS', '/dav/', { auth: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('dav'), /calendar-access/);
  assert.match(res.headers.get('dav'), /addressbook/);
});

test('requests without valid credentials get 401', async () => {
  const none = await s.request('PROPFIND', '/dav/', { auth: false, headers: { Depth: '0' } });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Basic realm=/);
  const bad = await s.request('PROPFIND', '/dav/', { headers: { Depth: '0', Authorization: 'Basic ' + Buffer.from('alice:wrong').toString('base64') } });
  assert.equal(bad.status, 401);
});

test('principal discovery', async () => {
  const res = await s.request('PROPFIND', '/dav/', {
    headers: { ...xml, Depth: '0' },
    body: '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
  });
  assert.equal(res.status, 207);
  assert.match(await res.text(), /\/dav\/principals\/alice\//);

  const p = await s.request('PROPFIND', '/dav/principals/alice/', {
    headers: { ...xml, Depth: '0' },
    body: '<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"><prop><c:calendar-home-set/><card:addressbook-home-set/></prop></propfind>',
  });
  const text = await p.text();
  assert.match(text, /\/dav\/calendars\/alice\//);
  assert.match(text, /\/dav\/addressbooks\/alice\//);
});

test('Depth: infinity is rejected', async () => {
  const res = await s.request('PROPFIND', '/dav/', { headers: { Depth: 'infinity' } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /propfind-finite-depth/);
});

test('users cannot access other users', async () => {
  const res = await s.request('PROPFIND', '/dav/calendars/bob/', { headers: { Depth: '0' } });
  assert.equal(res.status, 403);
});

test('calendar object lifecycle with etags and preconditions', async () => {
  const url = CAL + 'a.ics';
  const put = await s.request('PUT', url, { body: ics('uid-a'), headers: { 'If-None-Match': '*' } });
  assert.equal(put.status, 201);
  const etag = put.headers.get('etag');
  assert.ok(etag);

  const again = await s.request('PUT', url, { body: ics('uid-a'), headers: { 'If-None-Match': '*' } });
  assert.equal(again.status, 412);

  const get = await s.request('GET', url);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('etag'), etag);
  assert.match(get.headers.get('content-type'), /text\/calendar/);
  assert.match(await get.text(), /UID:uid-a/);

  const cached = await s.request('GET', url, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);

  const stale = await s.request('PUT', url, { body: ics('uid-a'), headers: { 'If-Match': '"nope"' } });
  assert.equal(stale.status, 412);

  const upd = await s.request('PUT', url, { body: ics('uid-a', '20300102T100000Z'), headers: { 'If-Match': etag } });
  assert.equal(upd.status, 204);
  assert.notEqual(upd.headers.get('etag'), etag);

  const del = await s.request('DELETE', url);
  assert.equal(del.status, 204);
  assert.equal((await s.request('GET', url)).status, 404);
});

test('invalid calendar data and UID conflicts', async () => {
  const bad = await s.request('PUT', CAL + 'bad.ics', { body: 'not a calendar' });
  assert.equal(bad.status, 403);
  assert.match(await bad.text(), /valid-calendar-data/);

  assert.equal((await s.request('PUT', CAL + 'one.ics', { body: ics('dup') })).status, 201);
  const conflict = await s.request('PUT', CAL + 'two.ics', { body: ics('dup') });
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /no-uid-conflict/);
  await s.request('DELETE', CAL + 'one.ics');
});

test('oversized PUT is rejected with 413', async () => {
  const small = await startServer({ MAX_RESOURCE_SIZE: '1000' });
  try {
    const res = await small.request('PUT', CAL + 'big.ics', { body: ics('big', '20300101T100000Z', `DESCRIPTION:${'x'.repeat(2000)}\r\n`) });
    assert.equal(res.status, 413);
  } finally {
    await small.close();
  }
});

test('MKCALENDAR, PROPPATCH and calendar-query with time-range', async () => {
  const mk = await s.request('MKCALENDAR', '/dav/calendars/alice/work/', {
    headers: xml,
    body: `<c:mkcalendar xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><set><prop><displayname>Work</displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></prop></set></c:mkcalendar>`,
  });
  assert.equal(mk.status, 201);
  assert.equal((await s.request('MKCALENDAR', '/dav/calendars/alice/work/')).status, 405);

  const pp = await s.request('PROPPATCH', '/dav/calendars/alice/work/', {
    headers: xml,
    body: `<propertyupdate xmlns="DAV:" xmlns:ic="http://apple.com/ns/ical/"><set><prop><ic:calendar-color>#ff0000</ic:calendar-color></prop></set></propertyupdate>`,
  });
  assert.equal(pp.status, 207);
  assert.match(await pp.text(), /200 OK/);

  const bad = await s.request('PROPPATCH', '/dav/calendars/alice/work/', {
    headers: xml,
    body: `<propertyupdate xmlns="DAV:"><set><prop><getetag>x</getetag></prop></set></propertyupdate>`,
  });
  assert.match(await bad.text(), /403 Forbidden/);

  const w = '/dav/calendars/alice/work/';
  await s.request('PUT', w + 'jan.ics', { body: ics('jan', '20300115T100000Z') });
  await s.request('PUT', w + 'mar.ics', { body: ics('mar', '20300315T100000Z') });
  await s.request('PUT', w + 'weekly.ics', { body: ics('weekly', '20300101T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4\r\n') });

  const query = (start, end) => s.request('REPORT', w, {
    headers: { ...xml, Depth: '1' },
    body: `<c:calendar-query xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><getetag/></prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
  });
  const jan = await (await query('20300110T000000Z', '20300120T000000Z')).text();
  assert.match(jan, /jan\.ics/);
  assert.doesNotMatch(jan, /mar\.ics/);
  assert.match(jan, /weekly\.ics/); // occurrence on 2030-01-15
  const mar = await (await query('20300301T000000Z', '20300401T000000Z')).text();
  assert.match(mar, /mar\.ics/);
  assert.doesNotMatch(mar, /jan\.ics/);
  assert.doesNotMatch(mar, /weekly\.ics/); // only 4 weekly occurrences

  const multi = await s.request('REPORT', w, {
    headers: xml,
    body: `<c:calendar-multiget xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><getetag/><c:calendar-data/></prop><href>${w}jan.ics</href><href>${w}missing.ics</href></c:calendar-multiget>`,
  });
  const mt = await multi.text();
  assert.match(mt, /BEGIN:VCALENDAR/);
  assert.match(mt, /404 Not Found/);
});

test('sync-collection reports additions and deletions', async () => {
  const w = '/dav/calendars/alice/sync/';
  await s.request('MKCALENDAR', w);
  const sync = async (token) => {
    const res = await s.request('REPORT', w, {
      headers: xml,
      body: `<sync-collection xmlns="DAV:"><sync-token>${token}</sync-token><sync-level>1</sync-level><prop><getetag/></prop></sync-collection>`,
    });
    const text = await res.text();
    return { status: res.status, text, token: /<D:sync-token>([^<]+)</.exec(text)?.[1] };
  };
  const first = await sync('');
  assert.equal(first.status, 207);
  assert.ok(first.token);

  await s.request('PUT', w + 'x.ics', { body: ics('sx') });
  await s.request('PUT', w + 'y.ics', { body: ics('sy') });
  const second = await sync(first.token);
  assert.match(second.text, /x\.ics/);
  assert.match(second.text, /y\.ics/);

  await s.request('DELETE', w + 'x.ics');
  const third = await sync(second.token);
  assert.match(third.text, /x\.ics/);
  assert.match(third.text, /404 Not Found/);
  assert.doesNotMatch(third.text, /y\.ics/);

  const idle = await sync(third.token);
  assert.doesNotMatch(idle.text, /<D:response>/);

  const invalid = await sync('http://example.com/bogus');
  assert.equal(invalid.status, 403);
});

test('address books: PUT, query, multiget, delete', async () => {
  assert.equal((await s.request('PUT', BOOK + 'jane.vcf', { body: vcf('c1', 'Jane Doe') })).status, 201);
  assert.equal((await s.request('PUT', BOOK + 'john.vcf', { body: vcf('c2', 'John Smith') })).status, 201);
  assert.equal((await s.request('PUT', BOOK + 'bad.vcf', { body: 'nope' })).status, 403);

  const q = await s.request('REPORT', BOOK, {
    headers: xml,
    body: `<card:addressbook-query xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><prop><getetag/><card:address-data/></prop><card:filter><card:prop-filter name="FN"><card:text-match match-type="contains">smith</card:text-match></card:prop-filter></card:filter></card:addressbook-query>`,
  });
  const text = await q.text();
  assert.match(text, /john\.vcf/);
  assert.doesNotMatch(text, /jane\.vcf/);
  assert.match(text, /FN:John Smith/);

  const list = await s.request('PROPFIND', BOOK, { headers: { Depth: '1' } });
  const lt = await list.text();
  assert.match(lt, /jane\.vcf/);
  assert.match(lt, /text\/vcard/);

  assert.equal((await s.request('DELETE', BOOK + 'jane.vcf')).status, 204);
});

test('malicious XML is rejected', async () => {
  const res = await s.request('PROPFIND', '/dav/', {
    headers: { ...xml, Depth: '0' },
    body: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:"><prop>&e;</prop></propfind>',
  });
  assert.equal(res.status, 400);
});

test('path traversal and unknown methods', async () => {
  assert.equal((await s.request('GET', '/dav/calendars/alice/..%2f..%2fx')).status, 400);
  assert.equal((await s.request('GET', '/elsewhere')).status, 404);
  assert.equal((await s.request('BIND', CAL + 'a.ics')).status, 501);
});

test('concurrent writers: UID conflicts and If-None-Match are serialised', async () => {
  const w = '/dav/calendars/alice/race/';
  await s.request('MKCALENDAR', w);

  const sameUid = await Promise.all(Array.from({ length: 8 }, (_, i) => s.request('PUT', `${w}uid-${i}.ics`, { body: ics('same-uid') })));
  const statuses = sameUid.map((res) => res.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409]);

  const sameUri = await Promise.all(Array.from({ length: 8 }, (_, i) => s.request('PUT', `${w}one.ics`, { body: ics(`u${i}`), headers: { 'If-None-Match': '*' } })));
  assert.deepEqual(sameUri.map((res) => res.status).sort(), [201, 412, 412, 412, 412, 412, 412, 412]);

  const col = await s.store.getCollection((await s.store.getUserByName('alice')).id, 'calendar', 'race');
  assert.equal(col.sync_token, 3); // two successful writes
});

test('NUL bytes are rejected instead of reaching PostgreSQL', async () => {
  const res = await s.request('PUT', CAL + 'nul.ics', { body: ics('nul', '20300101T100000Z', 'DESCRIPTION:a\0b\r\n') });
  assert.equal(res.status, 403);
  const pp = await s.request('PROPPATCH', CAL, {
    headers: xml,
    body: '<propertyupdate xmlns="DAV:"><set><prop><displayname>a&#0;b</displayname></prop></set></propertyupdate>',
  });
  assert.ok([400, 207].includes(pp.status));
});
