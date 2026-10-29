// CalDAV / CardDAV REPORT completeness: free-busy, expand, partial retrieval, collations, limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ics, vcf } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const xml = { 'Content-Type': 'application/xml' };
const NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="urn:ietf:params:xml:ns:carddav"';
const report = (path, body, headers = {}) => s.request('REPORT', path, { headers: { ...xml, Depth: '1', ...headers }, body });

const weekly = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
  'BEGIN:VEVENT', 'UID:weekly', 'DTSTAMP:20240101T000000Z', 'DTSTART:20300107T090000Z', 'DTEND:20300107T100000Z',
  'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Standup', 'LOCATION:Room 1',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:weekly', 'DTSTAMP:20240101T000000Z', 'RECURRENCE-ID:20300114T090000Z', 'DTSTART:20300114T110000Z', 'DTEND:20300114T120000Z',
  'SUMMARY:Standup (moved)',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

test('free-busy-query returns a VFREEBUSY with merged busy periods', async () => {
  const col = '/dav/calendars/alice/fb/';
  await s.request('MKCALENDAR', col);
  await s.request('PUT', col + 'a.ics', { body: ics('fb-a', '20300301T100000Z') });
  await s.request('PUT', col + 'b.ics', { body: ics('fb-b', '20300301T103000Z') });
  await s.request('PUT', col + 'tentative.ics', { body: ics('fb-t', '20300301T140000Z', 'STATUS:TENTATIVE\r\n') });
  await s.request('PUT', col + 'free.ics', { body: ics('fb-f', '20300301T160000Z', 'TRANSP:TRANSPARENT\r\n') });
  await s.request('PUT', col + 'cancelled.ics', { body: ics('fb-c', '20300301T170000Z', 'STATUS:CANCELLED\r\n') });
  await s.request('PUT', col + 'outside.ics', { body: ics('fb-o', '20300401T100000Z') });

  const res = await report(col, `<C:free-busy-query ${NS}><C:time-range start="20300301T000000Z" end="20300302T000000Z"/></C:free-busy-query>`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  const body = await res.text();
  assert.match(body, /BEGIN:VFREEBUSY/);
  assert.match(body, /FREEBUSY:20300301T100000Z\/20300301T113000Z\r\n/);
  assert.match(body, /FREEBUSY;FBTYPE=BUSY-TENTATIVE:20300301T140000Z\/20300301T150000Z/);
  assert.doesNotMatch(body, /20300301T160000Z|20300301T170000Z|20300401/);

  const bad = await report(col, `<C:free-busy-query ${NS}><C:time-range start="20300301"/></C:free-busy-query>`);
  assert.equal(bad.status, 403);
});

test('expand returns UTC instances with overrides applied', async () => {
  const col = '/dav/calendars/alice/ex/';
  await s.request('MKCALENDAR', col);
  await s.request('PUT', col + 'weekly.ics', { body: weekly });
  const res = await report(col, `<C:calendar-multiget ${NS}><prop><getetag/><C:calendar-data><C:expand start="20300107T000000Z" end="20300129T000000Z"/></C:calendar-data></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  const text = await res.text();
  assert.equal(res.status, 207);
  const data = /calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/.exec(text)[1];
  assert.equal((data.match(/BEGIN:VEVENT/g) ?? []).length, 4);
  assert.doesNotMatch(data, /RRULE/);
  assert.match(data, /RECURRENCE-ID:20300107T090000Z/);
  assert.match(data, /RECURRENCE-ID:20300121T090000Z/);
  assert.match(data, /RECURRENCE-ID:20300128T090000Z/);
  assert.match(data, /DTSTART:20300114T110000Z/);
  assert.match(data, /Standup \(moved\)/);
  assert.doesNotMatch(data, /DTSTART:20300114T090000Z/);

  const unbounded = await report(col, `<C:calendar-multiget ${NS}><prop><C:calendar-data><C:expand start="20300107T000000Z"/></C:calendar-data></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  assert.equal(unbounded.status, 403);
});

test('limit-recurrence-set keeps the master and only the overrides in range', async () => {
  const col = '/dav/calendars/alice/ex/';
  const res = await report(col, `<C:calendar-multiget ${NS}><prop><C:calendar-data><C:limit-recurrence-set start="20300120T000000Z" end="20300130T000000Z"/></C:calendar-data></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  const data = await res.text();
  assert.match(data, /RRULE:FREQ=WEEKLY/);
  assert.doesNotMatch(data, /moved/);
  const inRange = await report(col, `<C:calendar-multiget ${NS}><prop><C:calendar-data><C:limit-recurrence-set start="20300113T000000Z" end="20300116T000000Z"/></C:calendar-data></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  assert.match(await inRange.text(), /moved/);
});

test('partial calendar-data selects components and properties', async () => {
  const col = '/dav/calendars/alice/ex/';
  const res = await report(col, `<C:calendar-multiget ${NS}><prop><C:calendar-data><C:comp name="VCALENDAR"><C:prop name="VERSION"/><C:comp name="VEVENT"><C:prop name="UID"/><C:prop name="SUMMARY" novalue="yes"/></C:comp></C:comp></C:calendar-data></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  const text = await res.text();
  assert.match(text, /VERSION:2.0/);
  assert.match(text, /UID:weekly/);
  assert.match(text, /SUMMARY:&#13;/);
  assert.doesNotMatch(text, /PRODID|LOCATION|DTSTART|RRULE/);

  const unsupported = await report(col, `<C:calendar-multiget ${NS}><prop><C:calendar-data content-type="text/plain"/></prop><href>${col}weekly.ics</href></C:calendar-multiget>`);
  assert.equal(unsupported.status, 403);
  assert.match(await unsupported.text(), /supported-calendar-data/);
});

test('partial address-data returns only the requested vCard properties', async () => {
  const book = '/dav/addressbooks/alice/default/';
  await s.request('PUT', book + 'p.vcf', { body: `${vcf('pa-1', 'Pat').replace('END:VCARD', 'EMAIL:pat@example.com\r\nTEL:123\r\nEND:VCARD')}` });
  const res = await report(book, `<A:addressbook-multiget ${NS}><prop><A:address-data><A:prop name="FN"/><A:prop name="EMAIL"/></A:address-data></prop><href>${book}p.vcf</href></A:addressbook-multiget>`);
  const text = await res.text();
  assert.match(text, /FN:Pat/);
  assert.match(text, /EMAIL:pat@example.com/);
  assert.match(text, /VERSION:3.0/);
  assert.doesNotMatch(text, /TEL:|UID:/);
  const conv = await report(book, `<A:addressbook-multiget ${NS}><prop><A:address-data content-type="text/vcard" version="9.9"/></prop><href>${book}p.vcf</href></A:addressbook-multiget>`);
  assert.equal(conv.status, 403);
  assert.match(await conv.text(), /supported-address-data-conversion/);
});

test('addressbook-query limit truncates with a 507 on the collection', async () => {
  const book = '/dav/addressbooks/alice/lim/';
  await s.request('MKCOL', book, { headers: xml, body: `<mkcol ${NS}><set><prop><resourcetype><collection/><A:addressbook/></resourcetype></prop></set></mkcol>` });
  for (const n of [1, 2, 3]) await s.request('PUT', `${book}${n}.vcf`, { body: vcf(`lim-${n}`, `Person ${n}`) });
  const res = await report(book, `<A:addressbook-query ${NS}><prop><getetag/></prop><A:filter><A:prop-filter name="FN"/></A:filter><A:limit><A:nresults>2</A:nresults></A:limit></A:addressbook-query>`);
  const text = await res.text();
  assert.equal((text.match(/\.vcf</g) ?? []).length, 2);
  assert.match(text, /507/);
  assert.match(text, /number-of-matches-within-limits/);
  const all = await report(book, `<A:addressbook-query ${NS}><prop><getetag/></prop><A:limit><A:nresults>3</A:nresults></A:limit></A:addressbook-query>`);
  assert.doesNotMatch(await all.text(), /507/);
});

test('collations: ascii-casemap, octet, unknown', async () => {
  const book = '/dav/addressbooks/alice/default/';
  await s.request('PUT', book + 'ci.vcf', { body: vcf('col-1', 'Zoë MÜller') });
  const query = (collation, value, type = 'equals') => report(book, `<A:addressbook-query ${NS}><prop><getetag/></prop><A:filter><A:prop-filter name="FN"><A:text-match collation="${collation}" match-type="${type}">${value}</A:text-match></A:prop-filter></A:filter></A:addressbook-query>`);
  assert.match(await (await query('i;unicode-casemap', 'zoë müller')).text(), /ci\.vcf/);
  assert.doesNotMatch(await (await query('i;ascii-casemap', 'zoë müller')).text(), /ci\.vcf/);
  assert.match(await (await query('i;ascii-casemap', 'zoë m', 'starts-with')).text(), /ci\.vcf/);
  assert.doesNotMatch(await (await query('i;octet', 'zoë müller')).text(), /ci\.vcf/);
  const unknown = await query('i;nope', 'x');
  assert.equal(unknown.status, 403);
  assert.match(await unknown.text(), /supported-collation/);

  const prop = await s.request('PROPFIND', book, { headers: { ...xml, Depth: '0' }, body: `<propfind ${NS}><prop><A:supported-collation-set/></prop></propfind>` });
  assert.match(await prop.text(), /i;unicode-casemap/);
});

test('VALARM time-range matches alarm trigger times', async () => {
  const col = '/dav/calendars/alice/al/';
  await s.request('MKCALENDAR', col);
  const alarm = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n';
  await s.request('PUT', col + 'a.ics', { body: ics('al-1', '20300501T100000Z', alarm) });
  const q = (start, end) => report(col, `<C:calendar-query ${NS}><prop><getetag/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:comp-filter name="VALARM"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
  assert.match(await (await q('20300501T094000Z', '20300501T094600Z')).text(), /a\.ics/);
  assert.doesNotMatch(await (await q('20300501T100000Z', '20300501T110000Z')).text(), /a\.ics/);
});

test('calendar-timezone must be a single VTIMEZONE', async () => {
  const col = '/dav/calendars/alice/tz/';
  const body = (tz) => `<C:mkcalendar ${NS}><set><prop><C:calendar-timezone>${tz}</C:calendar-timezone></prop></set></C:mkcalendar>`;
  const bad = await s.request('MKCALENDAR', col, { headers: xml, body: body('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n') });
  assert.equal(bad.status, 403);
  assert.match(await bad.text(), /valid-calendar-data/);
  const good = await s.request('MKCALENDAR', col, {
    headers: xml,
    body: body('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n'),
  });
  assert.equal(good.status, 201);
});

test('resource limits advertise and enforce min/max-date-time, max-instances, max-attendees', async () => {
  const l = await startServer({ MIN_DATE_TIME: '20000101T000000Z', MAX_DATE_TIME: '21000101T000000Z', MAX_INSTANCES: '5', MAX_ATTENDEES: '2' });
  try {
    const col = '/dav/calendars/alice/default/';
    const prop = await l.request('PROPFIND', col, {
      headers: { ...xml, Depth: '0' },
      body: `<propfind ${NS}><prop><C:min-date-time/><C:max-date-time/><C:max-instances/><C:max-attendees-per-instance/></prop></propfind>`,
    });
    const text = await prop.text();
    assert.match(text, /min-date-time>20000101T000000Z/);
    assert.match(text, /max-instances>5</);
    assert.match(text, /max-attendees-per-instance>2</);

    const err = async (body) => {
      const res = await l.request('PUT', col + `${Math.random()}.ics`, { body });
      return [res.status, await res.text()];
    };
    assert.match((await err(ics('lim-early', '19990101T000000Z')))[1], /min-date-time/);
    assert.match((await err(ics('lim-late', '21500101T000000Z')))[1], /max-date-time/);
    assert.match((await err(ics('lim-inf', '20300101T100000Z', 'RRULE:FREQ=DAILY\r\n')))[1], /max-instances/);
    assert.match((await err(ics('lim-many', '20300101T100000Z', 'RRULE:FREQ=DAILY;COUNT=6\r\n')))[1], /max-instances/);
    assert.equal((await err(ics('lim-ok', '20300101T100000Z', 'RRULE:FREQ=DAILY;COUNT=5\r\n')))[0], 201);
    const attendees = 'ATTENDEE:mailto:a@x.org\r\nATTENDEE:mailto:b@x.org\r\nATTENDEE:mailto:c@x.org\r\n';
    assert.match((await err(ics('lim-att', '20300101T100000Z', attendees)))[1], /max-attendees-per-instance/);
  } finally {
    await l.close();
  }
});
