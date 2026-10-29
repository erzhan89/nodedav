// RFC 3744: ACL properties, principal reports, the (read-only) ACL method.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const xml = { 'Content-Type': 'application/xml' };
const NS = 'xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';

test('advertises access-control and exposes ACL properties', async () => {
  const res = await s.request('PROPFIND', '/dav/calendars/alice/default/', {
    headers: { ...xml, Depth: '0' },
    body: `<propfind ${NS}><prop><acl/><acl-restrictions/><supported-privilege-set/><inherited-acl-set/><owner/></prop></propfind>`,
  });
  assert.match(res.headers.get('dav'), /access-control/);
  const text = await res.text();
  assert.match(text, /<D:ace><D:principal><D:href>\/dav\/principals\/alice\/<\/D:href><\/D:principal><D:grant>/);
  assert.match(text, /<D:protected\/>/);
  assert.match(text, /<D:grant-only\/><D:no-invert\/>/);
  assert.match(text, /<D:supported-privilege><D:privilege><D:all\/>/);
  assert.match(text, /C:read-free-busy/);
  assert.match(text, /<D:read-acl\/>/);

  const pub = await s.request('PROPFIND', '/dav/', { headers: { ...xml, Depth: '0' }, body: `<propfind ${NS}><prop><acl/></prop></propfind>` });
  assert.match(await pub.text(), /<D:authenticated\/>/);
});

test('ACL method refuses changes to the protected ACL', async () => {
  const res = await s.request('ACL', '/dav/calendars/alice/default/', {
    headers: xml,
    body: `<acl ${NS}><ace><principal><href>/dav/principals/bob/</href></principal><grant><privilege><read/></privilege></grant></ace></acl>`,
  });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /no-protected-ace-conflict/);
  assert.equal((await s.request('ACL', '/dav/calendars/alice/nope/', { headers: xml, body: `<acl ${NS}/>` })).status, 404);
});

test('principal-search-property-set lists searchable properties', async () => {
  const res = await s.request('REPORT', '/dav/principals/', { headers: { ...xml, Depth: '0' }, body: `<principal-search-property-set ${NS}/>` });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /principal-search-property/);
  assert.match(text, /<D:displayname\/>/);
});

test('principal-property-search finds the caller by display name', async () => {
  const search = (match, extra = '') => s.request('REPORT', '/dav/principals/', {
    headers: { ...xml, Depth: '0' },
    body: `<principal-property-search ${NS}${extra}><property-search><prop><displayname/></prop><match>${match}</match></property-search><prop><displayname/><C:calendar-home-set/></prop></principal-property-search>`,
  });
  const hit = await search('ALIC');
  assert.equal(hit.status, 207);
  const text = await hit.text();
  assert.match(text, /\/dav\/principals\/alice\//);
  assert.match(text, /calendar-home-set><D:href>\/dav\/calendars\/alice\//);
  assert.doesNotMatch(await (await search('zzz-nothing')).text(), /principals\/alice/);
  assert.doesNotMatch(await (await search('bob')).text(), /principals\/bob/);
});

test('principal-match finds the current user and owned resources', async () => {
  const self = await s.request('REPORT', '/dav/principals/', { headers: { ...xml, Depth: '1' }, body: `<principal-match ${NS}><self/><prop><displayname/></prop></principal-match>` });
  assert.match(await self.text(), /\/dav\/principals\/alice\//);
  const owned = await s.request('REPORT', '/dav/calendars/alice/', {
    headers: { ...xml, Depth: '1' },
    body: `<principal-match ${NS}><principal-property><owner/></principal-property><prop><displayname/></prop></principal-match>`,
  });
  const text = await owned.text();
  assert.match(text, /calendars\/alice\/default\//);
  assert.equal((await s.request('REPORT', '/dav/principals/', { headers: xml, body: `<principal-match ${NS}/>` })).status, 400);
});

test('acl-principal-prop-set returns the principals named in the ACL', async () => {
  const res = await s.request('REPORT', '/dav/calendars/alice/default/', { headers: { ...xml, Depth: '0' }, body: `<acl-principal-prop-set ${NS}><prop><displayname/></prop></acl-principal-prop-set>` });
  assert.match(await res.text(), /\/dav\/principals\/alice\//);
});
