// RFC 6638 scheduling: discovery, implicit scheduling, iTIP delivery, free-busy, outbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ics } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  for (const name of ['alice', 'bob']) {
    const user = await s.store.getUserByName(name);
    await s.store.updateUser(user.id, { email: `${name}@example.org` });
  }
});
after(async () => { await s.close(); });

const xml = { 'Content-Type': 'application/xml' };
const NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';
const cal = 'text/calendar; charset=utf-8';
const unescape = (t) => t.replaceAll('&#13;', '').replace(/\r?\n[ \t]/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

const invite = (uid, { start = '20300601T100000Z', attendees = ['bob@example.org'], extra = '' } = {}) =>
  ics(uid, start, `ORGANIZER;CN=Alice:mailto:alice@example.org\r\n${attendees.map((a) => `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}\r\n`).join('')}${extra}`);

/** Concatenated, unescaped calendar-data of every object in a collection. */
async function dump(user, collection) {
  const res = await s.request('PROPFIND', `/dav/calendars/${user}/${collection}/`, {
    user, headers: { ...xml, Depth: '1' }, body: `<propfind ${NS}><prop><getetag/><C:calendar-data/></prop></propfind>`,
  });
  return unescape(await res.text());
}
const count = (text, re) => (text.match(re) ?? []).length;

test('discovery: principal properties, inbox and outbox resources', async () => {
  const principal = await s.request('PROPFIND', '/dav/principals/alice/', {
    headers: { ...xml, Depth: '0' },
    body: `<propfind ${NS}><prop><C:schedule-inbox-URL/><C:schedule-outbox-URL/><C:calendar-user-type/><C:calendar-user-address-set/></prop></propfind>`,
  });
  assert.equal(principal.headers.get('dav').includes('calendar-auto-schedule'), true);
  const text = await principal.text();
  assert.match(text, /schedule-inbox-URL><D:href>\/dav\/calendars\/alice\/inbox\//);
  assert.match(text, /schedule-outbox-URL><D:href>\/dav\/calendars\/alice\/outbox\//);
  assert.match(text, /calendar-user-type>INDIVIDUAL</);
  assert.match(text, /mailto:alice@example.org/);

  const home = await s.request('PROPFIND', '/dav/calendars/alice/', { headers: { ...xml, Depth: '1' }, body: `<propfind ${NS}><prop><resourcetype/></prop></propfind>` });
  const homeText = await home.text();
  assert.match(homeText, /<C:schedule-inbox\/>/);
  assert.match(homeText, /<C:schedule-outbox\/>/);
  assert.equal(count(homeText, /<C:calendar\/>/g), 1);

  const privs = await s.request('PROPFIND', '/dav/calendars/alice/inbox/', { headers: { ...xml, Depth: '0' }, body: `<propfind ${NS}><prop><current-user-privilege-set/></prop></propfind>` });
  assert.match(await privs.text(), /schedule-deliver/);
});

test('organizer PUT delivers a REQUEST, places the event for the attendee and reports SCHEDULE-STATUS', async () => {
  const put = await s.request('PUT', '/dav/calendars/alice/default/inv1.ics', { headers: { 'Content-Type': cal }, body: invite('inv1', { attendees: ['bob@example.org', 'ext@other.org'] }) });
  assert.equal(put.status, 201);
  assert.equal(put.headers.get('etag'), null, 'a body modified by the server has no ETag');

  const mine = unescape(await (await s.request('GET', '/dav/calendars/alice/default/inv1.ics')).text());
  assert.match(mine, /SCHEDULE-STATUS=1\.2:mailto:bob@example\.org/);
  assert.match(mine, /SCHEDULE-STATUS=5\.3:mailto:ext@other\.org/);

  const inbox = await dump('bob', 'inbox');
  assert.match(inbox, /METHOD:REQUEST/);
  assert.match(inbox, /UID:inv1/);
  assert.doesNotMatch(inbox, /SCHEDULE-STATUS/);

  const bobs = await dump('bob', 'default');
  assert.match(bobs, /UID:inv1/);
  assert.doesNotMatch(bobs, /METHOD/);
  assert.match(bobs, /PARTSTAT=NEEDS-ACTION/);

  const second = await s.request('PUT', '/dav/calendars/alice/default/inv1.ics', { headers: { 'Content-Type': cal }, body: mine });
  assert.equal(second.status, 204);
  assert.ok(second.headers.get('etag'), 'unchanged body keeps its ETag');
});

test('attendee PARTSTAT change sends a REPLY that updates the organizer copy', async () => {
  const bobs = unescape(await (await s.request('GET', await findHref('bob', 'inv1'), { user: 'bob' })).text());
  const accepted = bobs.replace(/PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example\.org/, 'PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@example.org');
  assert.notEqual(accepted, bobs);
  const put = await s.request('PUT', await findHref('bob', 'inv1'), { user: 'bob', headers: { 'Content-Type': cal }, body: accepted });
  assert.equal(put.status, 204);

  const inbox = await dump('alice', 'inbox');
  assert.match(inbox, /METHOD:REPLY/);
  assert.match(inbox, /PARTSTAT=ACCEPTED[^\n]*mailto:bob@example\.org/);
  const mine = unescape(await (await s.request('GET', '/dav/calendars/alice/default/inv1.ics')).text());
  assert.match(mine, /PARTSTAT=ACCEPTED[^\n]*mailto:bob@example\.org/);
  assert.match(mine, /PARTSTAT=NEEDS-ACTION[^\n]*mailto:ext@other\.org/);
});

async function findHref(user, uid) {
  const res = await s.request('REPORT', `/dav/calendars/${user}/default/`, {
    user, headers: { ...xml, Depth: '1' },
    body: `<C:calendar-query ${NS}><prop><getetag/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match>${uid}</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
  });
  return /<D:href>([^<]+\.ics)</.exec(await res.text())[1];
}

test('removing an attendee cancels for them; deleting as organizer cancels for the rest', async () => {
  await s.request('PUT', '/dav/calendars/alice/default/inv2.ics', { headers: { 'Content-Type': cal }, body: invite('inv2') });
  assert.match(await dump('bob', 'default'), /UID:inv2/);

  const stripped = ics('inv2', '20300601T100000Z', 'ORGANIZER;CN=Alice:mailto:alice@example.org\r\nATTENDEE:mailto:ext@other.org\r\n');
  await s.request('PUT', '/dav/calendars/alice/default/inv2.ics', { headers: { 'Content-Type': cal }, body: stripped });
  const bobInbox = await dump('bob', 'inbox');
  assert.match(bobInbox, /METHOD:CANCEL[\s\S]*UID:inv2/);
  const copy = (await dump('bob', 'default')).split('BEGIN:VCALENDAR').find((x) => x.includes('UID:inv2'));
  assert.match(copy, /STATUS:CANCELLED/);

  await s.request('PUT', '/dav/calendars/alice/default/inv3.ics', { headers: { 'Content-Type': cal }, body: invite('inv3') });
  const before = count(await dump('bob', 'inbox'), /METHOD:/g);
  const quiet = await s.request('DELETE', '/dav/calendars/alice/default/inv3.ics', { headers: { 'Schedule-Reply': 'F' } });
  assert.equal(quiet.status, 204);
  assert.equal(count(await dump('bob', 'inbox'), /METHOD:/g), before, 'Schedule-Reply: F suppresses the CANCEL');

  await s.request('PUT', '/dav/calendars/alice/default/inv4.ics', { headers: { 'Content-Type': cal }, body: invite('inv4') });
  await s.request('DELETE', '/dav/calendars/alice/default/inv4.ics');
  const copy4 = (await dump('bob', 'default')).split('BEGIN:VCALENDAR').find((x) => x.includes('UID:inv4'));
  assert.match(copy4, /STATUS:CANCELLED/);
});

test('an attendee deleting the event declines for the organizer', async () => {
  await s.request('PUT', '/dav/calendars/alice/default/inv5.ics', { headers: { 'Content-Type': cal }, body: invite('inv5') });
  const del = await s.request('DELETE', await findHref('bob', 'inv5'), { user: 'bob' });
  assert.equal(del.status, 204);
  const mine = unescape(await (await s.request('GET', '/dav/calendars/alice/default/inv5.ics')).text());
  assert.match(mine, /PARTSTAT=DECLINED[^\n]*mailto:bob@example\.org/);
});

test('scheduling is skipped for SCHEDULE-AGENT=CLIENT and for events without an organizer', async () => {
  const before = count(await dump('bob', 'inbox'), /METHOD:/g);
  const clientSide = ics('agent', '20300602T100000Z', 'ORGANIZER:mailto:alice@example.org\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:bob@example.org\r\n');
  const put = await s.request('PUT', '/dav/calendars/alice/default/agent.ics', { headers: { 'Content-Type': cal }, body: clientSide });
  assert.ok(put.headers.get('etag'));
  await s.request('PUT', '/dav/calendars/alice/default/plain.ics', { headers: { 'Content-Type': cal }, body: ics('plain') });
  assert.equal(count(await dump('bob', 'inbox'), /METHOD:/g), before);
});

test('inbox is server-written: no PUT or copy into it, items can be deleted, name is reserved', async () => {
  const put = await s.request('PUT', '/dav/calendars/alice/inbox/x.ics', { headers: { 'Content-Type': cal }, body: ics('x') });
  assert.equal(put.status, 403);
  const mk = await s.request('MKCALENDAR', '/dav/calendars/alice/inbox/');
  assert.equal(mk.status, 405);
  const src = await s.request('PUT', '/dav/calendars/alice/default/cp.ics', { headers: { 'Content-Type': cal }, body: ics('cp') });
  assert.equal(src.status, 201);
  const copy = await s.request('COPY', '/dav/calendars/alice/default/cp.ics', { headers: { Destination: `${s.origin}/dav/calendars/alice/inbox/cp.ics` } });
  assert.equal(copy.status, 403);

  const listing = await s.request('PROPFIND', '/dav/calendars/alice/inbox/', { headers: { ...xml, Depth: '1' }, body: `<propfind ${NS}><prop><getetag/></prop></propfind>` });
  const href = /<D:href>(\/dav\/calendars\/alice\/inbox\/[^<]+\.ics)</.exec(await listing.text())[1];
  assert.equal((await s.request('DELETE', href)).status, 204);
  assert.equal((await s.request('PUT', '/dav/calendars/bob/inbox/', { user: 'alice', headers: { 'Content-Type': cal }, body: '' })).status, 403);
});

test('inbox supports calendar-query and sync-collection', async () => {
  const res = await s.request('REPORT', '/dav/calendars/bob/inbox/', {
    user: 'bob', headers: { ...xml, Depth: '1' },
    body: `<C:calendar-query ${NS}><prop><getetag/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`,
  });
  assert.equal(res.status, 207);
  assert.match(await res.text(), /inbox\/.+\.ics/);
  const sync = await s.request('REPORT', '/dav/calendars/bob/inbox/', {
    user: 'bob', headers: xml, body: `<sync-collection ${NS}><sync-token/><sync-level>1</sync-level><prop><getetag/></prop></sync-collection>`,
  });
  assert.equal(sync.status, 207);
});

test('schedule-default-calendar-URL chooses where invitations land', async () => {
  assert.equal((await s.request('MKCALENDAR', '/dav/calendars/bob/work/', { user: 'bob' })).status, 201);
  const patch = await s.request('PROPPATCH', '/dav/calendars/bob/inbox/', {
    user: 'bob', headers: xml,
    body: `<propertyupdate ${NS}><set><prop><C:schedule-default-calendar-URL><href>/dav/calendars/bob/work/</href></C:schedule-default-calendar-URL></prop></set></propertyupdate>`,
  });
  assert.match(await patch.text(), /200 OK/);
  const read = await s.request('PROPFIND', '/dav/calendars/bob/inbox/', { user: 'bob', headers: { ...xml, Depth: '0' }, body: `<propfind ${NS}><prop><C:schedule-default-calendar-URL/></prop></propfind>` });
  assert.match(await read.text(), /calendars\/bob\/work\//);

  await s.request('PUT', '/dav/calendars/alice/default/inv6.ics', { headers: { 'Content-Type': cal }, body: invite('inv6') });
  assert.match(await dump('bob', 'work'), /UID:inv6/);
  assert.doesNotMatch(await dump('bob', 'default'), /UID:inv6/);
});

const freeBusyRequest = (organizer, attendees, start = '20300701T000000Z', end = '20300702T000000Z') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', 'UID:fb-req',
  'DTSTAMP:20240101T000000Z', `DTSTART:${start}`, `DTEND:${end}`, `ORGANIZER:mailto:${organizer}`,
  ...attendees.map((a) => `ATTENDEE:mailto:${a}`), 'END:VFREEBUSY', 'END:VCALENDAR', '',
].join('\r\n');

test('outbox free-busy lookup answers per recipient', async () => {
  await s.request('PUT', '/dav/calendars/bob/default/busy.ics', { user: 'bob', headers: { 'Content-Type': cal }, body: ics('busy', '20300701T090000Z') });
  await s.request('PUT', '/dav/calendars/bob/default/free.ics', { user: 'bob', headers: { 'Content-Type': cal }, body: ics('free', '20300701T150000Z', 'TRANSP:TRANSPARENT\r\n') });

  const res = await s.request('POST', '/dav/calendars/alice/outbox/', {
    headers: { 'Content-Type': cal }, body: freeBusyRequest('alice@example.org', ['bob@example.org', 'nobody@example.org']),
  });
  assert.equal(res.status, 200);
  const text = unescape(await res.text());
  assert.match(text, /schedule-response/);
  assert.match(text, /<C:recipient><D:href>mailto:bob@example\.org<\/D:href><\/C:recipient><C:request-status>2\.0;Success/);
  assert.match(text, /METHOD:REPLY/);
  assert.match(text, /FREEBUSY:20300701T090000Z\/20300701T100000Z/);
  assert.doesNotMatch(text, /T150000Z/);
  assert.match(text, /mailto:nobody@example\.org<\/D:href><\/C:recipient><C:request-status>3\.7/);

  const principalHref = await s.request('POST', '/dav/calendars/alice/outbox/', {
    headers: { 'Content-Type': cal }, body: freeBusyRequest('alice@example.org', ['bob@example.org']).replace('ATTENDEE:mailto:bob@example.org', 'ATTENDEE:/dav/principals/bob/'),
  });
  assert.match(unescape(await principalHref.text()), /FREEBUSY:20300701T090000Z/);
});

test('calendars marked transparent are left out of free-busy', async () => {
  const patch = await s.request('PROPPATCH', '/dav/calendars/bob/work/', {
    user: 'bob', headers: xml,
    body: `<propertyupdate ${NS}><set><prop><C:schedule-calendar-transp><C:transparent/></C:schedule-calendar-transp></prop></set></propertyupdate>`,
  });
  assert.match(await patch.text(), /200 OK/);
  await s.request('PUT', '/dav/calendars/bob/work/hidden.ics', { user: 'bob', headers: { 'Content-Type': cal }, body: ics('hidden', '20300801T090000Z') });
  const res = await s.request('POST', '/dav/calendars/alice/outbox/', {
    headers: { 'Content-Type': cal }, body: freeBusyRequest('alice@example.org', ['bob@example.org'], '20300801T000000Z', '20300802T000000Z'),
  });
  assert.doesNotMatch(unescape(await res.text()), /^FREEBUSY/m);
});

test('outbox validates the message and who is sending it', async () => {
  const post = (body, user = 'alice', type = cal) => s.request('POST', `/dav/calendars/${user}/outbox/`, { user, headers: { 'Content-Type': type }, body });
  const impostor = await post(freeBusyRequest('bob@example.org', ['alice@example.org']));
  assert.equal(impostor.status, 403);
  assert.match(await impostor.text(), /organizer-allowed/);
  assert.equal((await post('not a calendar')).status, 403);
  assert.equal((await post(freeBusyRequest('alice@example.org', []))).status, 403);
  assert.equal((await post(freeBusyRequest('alice@example.org', ['bob@example.org'], '20300702T000000Z', '20300701T000000Z'))).status, 403);
  assert.equal((await post('x', 'alice', 'text/plain')).status, 415);
  assert.equal((await s.request('POST', '/dav/calendars/bob/outbox/', { user: 'alice', headers: { 'Content-Type': cal }, body: freeBusyRequest('alice@example.org', ['bob@example.org']) })).status, 403);
  assert.equal((await s.request('GET', '/dav/calendars/alice/outbox/')).status, 405);
});

test('outbox delivers explicit iTIP messages', async () => {
  const message = (method, extra) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:explicit',
    'DTSTAMP:20240101T000000Z', 'DTSTART:20300901T100000Z', 'DTEND:20300901T110000Z', 'SUMMARY:Explicit', ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const request = message('REQUEST', ['ORGANIZER:mailto:alice@example.org', 'ATTENDEE:mailto:bob@example.org']);
  const res = await s.request('POST', '/dav/calendars/alice/outbox/', { headers: { 'Content-Type': cal }, body: request });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /request-status>2\.0;Success/);
  assert.match(await dump('bob', 'inbox'), /UID:explicit/);

  const reply = message('REPLY', ['ORGANIZER:mailto:alice@example.org', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.org']);
  const answered = await s.request('POST', '/dav/calendars/bob/outbox/', { user: 'bob', headers: { 'Content-Type': cal }, body: reply });
  assert.equal(answered.status, 200);
  assert.match(await dump('alice', 'inbox'), /METHOD:REPLY[\s\S]*TENTATIVE/);

  const wrong = await s.request('POST', '/dav/calendars/bob/outbox/', { user: 'bob', headers: { 'Content-Type': cal }, body: request });
  assert.equal(wrong.status, 403);
  const forged = await s.request('POST', '/dav/calendars/bob/outbox/', {
    user: 'bob', headers: { 'Content-Type': cal }, body: message('REPLY', ['ORGANIZER:mailto:alice@example.org', 'ATTENDEE:mailto:alice@example.org']),
  });
  assert.match(await forged.text(), /attendee-allowed/);
});
