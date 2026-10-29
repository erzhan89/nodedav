// RFC 7265/7095 JSON representations, RFC 7809 timezone handling, RFC 7953 availability.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ics, vcf } from './helpers.js';

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
const NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="urn:ietf:params:xml:ns:carddav"';
const cal = 'text/calendar; charset=utf-8';
const unescape = (t) => t.replaceAll('&#13;', '').replace(/\r?\n[ \t]/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

test('GET negotiates jCal and jCard through Accept', async () => {
  await s.request('PUT', '/dav/calendars/alice/default/j1.ics', { headers: { 'Content-Type': cal }, body: ics('j1', '20300101T100000Z', 'LOCATION:Room\\, 4\r\n') });
  const res = await s.request('GET', '/dav/calendars/alice/default/j1.ics', { headers: { Accept: 'application/calendar+json' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/calendar\+json/);
  const [name, props, comps] = await res.json();
  assert.equal(name, 'vcalendar');
  assert.ok(props.some((p) => p[0] === 'version' && p[3] === '2.0'));
  const event = comps.find((x) => x[0] === 'vevent');
  const get = (n) => event[1].find((p) => p[0] === n);
  assert.equal(get('uid')[3], 'j1');
  assert.deepEqual(get('dtstart').slice(2), ['date-time', '2030-01-01T10:00:00Z']);
  assert.equal(get('location')[3], 'Room, 4');

  const plain = await s.request('GET', '/dav/calendars/alice/default/j1.ics');
  assert.match(plain.headers.get('content-type'), /text\/calendar/);

  await s.request('PUT', '/dav/addressbooks/alice/default/c1.vcf', { headers: { 'Content-Type': 'text/vcard' }, body: vcf('c1', 'Ann Lee') });
  const card = await s.request('GET', '/dav/addressbooks/alice/default/c1.vcf', { headers: { Accept: 'application/vcard+json' } });
  const [cname, cprops] = await card.json();
  assert.equal(cname, 'vcard');
  assert.ok(cprops.some((p) => p[0] === 'fn' && p[3] === 'Ann Lee'));
});

test('PUT accepts jCal and stores iCalendar; malformed JSON is a valid-calendar-data error', async () => {
  const body = JSON.stringify(['vcalendar', [['version', {}, 'text', '2.0'], ['prodid', {}, 'text', '-//t//EN']], [
    ['vevent', [
      ['uid', {}, 'text', 'jput'], ['dtstamp', {}, 'date-time', '2024-01-01T00:00:00Z'],
      ['dtstart', {}, 'date-time', '2030-02-01T09:00:00Z'], ['duration', {}, 'duration', 'PT30M'],
      ['summary', {}, 'text', 'From JSON'],
      ['rrule', {}, 'recur', { freq: 'WEEKLY', count: 3, byday: ['MO'] }],
    ], []],
  ]]);
  const put = await s.request('PUT', '/dav/calendars/alice/default/jput.ics', { headers: { 'Content-Type': 'application/calendar+json' }, body });
  assert.equal(put.status, 201);
  const text = unescape(await (await s.request('GET', '/dav/calendars/alice/default/jput.ics')).text());
  assert.match(text, /^DTSTART:20300201T090000Z/m);
  assert.match(text, /^RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO/m);
  assert.match(text, /^SUMMARY:From JSON/m);

  const broken = await s.request('PUT', '/dav/calendars/alice/default/jbad.ics', { headers: { 'Content-Type': 'application/calendar+json' }, body: '{"nope":' });
  assert.equal(broken.status, 403);
  assert.match(await broken.text(), /valid-calendar-data/);
});

test('REPORT can return calendar-data and address-data as JSON', async () => {
  const res = await s.request('REPORT', '/dav/calendars/alice/default/', {
    headers: { ...xml, Depth: '1' },
    body: `<C:calendar-multiget ${NS}><prop><C:calendar-data content-type="application/calendar+json" version="2.0"/></prop><href>/dav/calendars/alice/default/j1.ics</href></C:calendar-multiget>`,
  });
  assert.equal(res.status, 207);
  const m = /<C:calendar-data[^>]*>([\s\S]*?)<\/C:calendar-data>/.exec(await res.text());
  const parsed = JSON.parse(unescape(m[1]));
  assert.equal(parsed[0], 'vcalendar');

  const ab = await s.request('REPORT', '/dav/addressbooks/alice/default/', {
    headers: { ...xml, Depth: '1' },
    body: `<A:addressbook-multiget ${NS}><prop><A:address-data content-type="application/vcard+json" version="4.0"/></prop><href>/dav/addressbooks/alice/default/c1.vcf</href></A:addressbook-multiget>`,
  });
  const cm = /<[A-Za-z]+:address-data[^>]*>([\s\S]*?)<\/[A-Za-z]+:address-data>/.exec(await ab.text());
  assert.equal(JSON.parse(unescape(cm[1]))[0], 'vcard');

  const unsupported = await s.request('REPORT', '/dav/calendars/alice/default/', {
    headers: { ...xml, Depth: '1' },
    body: `<C:calendar-multiget ${NS}><prop><C:calendar-data content-type="text/x-nothing"/></prop><href>/dav/calendars/alice/default/j1.ics</href></C:calendar-multiget>`,
  });
  assert.equal(unsupported.status, 403);
});

test('CalDAV-Timezones: F drops VTIMEZONEs that the tz database already describes', async () => {
  const withZone = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:tz1\r\nDTSTAMP:20240101T000000Z\r\nDTSTART;TZID=Europe/Berlin:20300301T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  await s.request('PUT', '/dav/calendars/alice/default/tz1.ics', { headers: { 'Content-Type': cal }, body: withZone });
  const full = await (await s.request('GET', '/dav/calendars/alice/default/tz1.ics')).text();
  assert.match(full, /BEGIN:VTIMEZONE/);
  const slim = await (await s.request('GET', '/dav/calendars/alice/default/tz1.ics', { headers: { 'CalDAV-Timezones': 'F' } })).text();
  assert.doesNotMatch(slim, /VTIMEZONE/);
  assert.match(slim, /DTSTART;TZID=Europe\/Berlin:20300301T100000/);
  const opt = await s.request('OPTIONS', '/dav/');
  assert.match(opt.headers.get('dav'), /calendar-no-timezone/);
});

const freeBusyRequest = (start, end) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', 'UID:av-req',
  'DTSTAMP:20240101T000000Z', `DTSTART:${start}`, `DTEND:${end}`, 'ORGANIZER:mailto:alice@example.org',
  'ATTENDEE:mailto:bob@example.org', 'END:VFREEBUSY', 'END:VCALENDAR', '',
].join('\r\n');

const AVAILABILITY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VAVAILABILITY', 'UID:av1', 'DTSTAMP:20240101T000000Z',
  'DTSTART:20300101T000000Z', 'BEGIN:AVAILABLE', 'UID:av1-work', 'DTSTAMP:20240101T000000Z', 'DTSTART:20300701T090000Z',
  'DTEND:20300701T170000Z', 'SUMMARY:Work', 'END:AVAILABLE', 'END:VAVAILABILITY', 'END:VCALENDAR', '',
].join('\r\n');

const patchAvailability = (text) => s.request('PROPPATCH', '/dav/calendars/bob/inbox/', {
  user: 'bob', headers: xml,
  body: `<propertyupdate ${NS}><set><prop><C:calendar-availability>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</C:calendar-availability></prop></set></propertyupdate>`,
});

test('calendar-availability must be a single VAVAILABILITY', async () => {
  const bad = await patchAvailability('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nEND:VCALENDAR\r\n');
  assert.equal(bad.status, 403);
  assert.match(await bad.text(), /valid-calendar-data/);
  const good = await patchAvailability(AVAILABILITY);
  assert.match(await good.text(), /200 OK/);
});

test('outside the available hours the free-busy lookup reports BUSY-UNAVAILABLE', async () => {
  await patchAvailability(AVAILABILITY);
  const res = await s.request('POST', '/dav/calendars/alice/outbox/', {
    headers: { 'Content-Type': cal }, body: freeBusyRequest('20300701T000000Z', '20300702T000000Z'),
  });
  const text = unescape(await res.text());
  assert.match(text, /FBTYPE=BUSY-UNAVAILABLE:20300701T000000Z\/20300701T090000Z,20300701T170000Z\/20300702T000000Z/);
  assert.doesNotMatch(text, /20300701T090000Z\/20300701T170000Z/);
});
