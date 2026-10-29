import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, serialize, el, XmlError } from '../src/xml.js';
import { parseComponent } from '../src/ical.js';
import { expandStarts } from '../src/recurrence.js';
import { analyzeCalendar, CalendarError } from '../src/calendar.js';
import { analyzeVcard, VcardError } from '../src/vcard.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { ics, vcf } from './fixtures.js';

const event = (body) => parseComponent(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u\r\n${body}END:VEVENT\r\nEND:VCALENDAR\r\n`).comps[0];
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
const starts = (body, bound = Date.UTC(2031, 0, 1)) => expandStarts(event(body), bound).starts.map(iso);

test('xml: namespaces, entities and round trip', () => {
  const root = parseXml('<a:r xmlns:a="DAV:" xmlns="urn:x"><child k="v">t&amp;&#65;</child><a:other/></a:r>');
  assert.equal(root.tag, '{DAV:}r');
  assert.equal(root.children[0].tag, '{urn:x}child');
  assert.equal(root.children[0].text, 't&A');
  const out = serialize(el('{DAV:}response', null, el('{DAV:}href', null, 'a<b\r')));
  assert.match(out, /a&lt;b&#13;/);
  assert.equal(parseXml(out).children[0].text, 'a<b\r');
});

test('xml: rejects DTDs, undefined entities and deep nesting', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), XmlError);
  assert.throws(() => parseXml('<a>&x;</a>'), XmlError);
  assert.throws(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100)), XmlError);
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
});

test('ical: line unfolding and escapes', () => {
  const cal = parseComponent('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:long\r\n  line\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  assert.equal(cal.comps[0].props[0].value, 'long line');
});

test('recurrence: weekly, count, until, exdate', () => {
  assert.deepEqual(starts('DTSTART:20300101T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n'),
    ['2030-01-01T09:00', '2030-01-08T09:00', '2030-01-15T09:00']);
  assert.deepEqual(starts('DTSTART:20300101T090000Z\r\nRRULE:FREQ=DAILY;UNTIL=20300103T090000Z\r\nEXDATE:20300102T090000Z\r\n'),
    ['2030-01-01T09:00', '2030-01-03T09:00']);
});

test('recurrence: monthly ordinal weekday and BYSETPOS', () => {
  assert.deepEqual(starts('DTSTART:20300108T090000Z\r\nRRULE:FREQ=MONTHLY;COUNT=3;BYDAY=2TU\r\n'),
    ['2030-01-08T09:00', '2030-02-12T09:00', '2030-03-12T09:00']);
  assert.deepEqual(starts('DTSTART:20300131T090000Z\r\nRRULE:FREQ=MONTHLY;COUNT=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1\r\n').slice(0, 2),
    ['2030-01-31T09:00', '2030-02-28T09:00']);
});

test('recurrence: TZID is honoured and unsupported rules are flagged', () => {
  assert.deepEqual(starts('DTSTART;TZID=America/New_York:20300115T090000\r\n'), ['2030-01-15T14:00']);
  assert.equal(expandStarts(event('DTSTART:20300101T090000Z\r\nRRULE:FREQ=DAILY;BYHOUR=1,2\r\n'), Infinity).status, 'unsupported');
});

test('calendar: analyzeCalendar extracts uid, type and range', () => {
  const meta = analyzeCalendar(ics('abc'));
  assert.equal(meta.uid, 'abc');
  assert.equal(meta.componentType, 'VEVENT');
  assert.equal(meta.lastOccurrence - meta.firstOccurrence, 3600);
  assert.throws(() => analyzeCalendar('garbage'), CalendarError);
  assert.throws(() => analyzeCalendar(ics('x').replace('PRODID', 'METHOD:REQUEST\r\nPRODID')), CalendarError);
});

test('vcard: version and uid handling', () => {
  assert.equal(analyzeVcard(vcf('id1', 'A')).uid, 'id1');
  assert.throws(() => analyzeVcard('BEGIN:VCARD\r\nVERSION:1.0\r\nFN:x\r\nEND:VCARD\r\n'), VcardError);
});

test('auth: password hashing', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.notEqual(hash, await hashPassword('correct horse'));
});
