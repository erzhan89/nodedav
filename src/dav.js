import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { HttpError, davError } from './errors.js';
import { parseXml, serialize, el, childOf, childrenOf, freezeNode, XmlError } from './xml.js';
import { d, c, card } from './ns.js';
import {
  resolve, parsePath, hrefOf, hrefFor, listChildren, objectResource, WRITABLE, DATA_PROPS, QUOTA_PROPS, PROPS, deadKey,
} from './resources.js';
import { multistatus, propResponse, propstat, minimize } from './multistatus.js';
import {
  ensureLocks, checkIf, assertUnlocked, pathKey, lockCovers, newToken, parseTimeout, conflictingLocks, activeLock,
} from './locks.js';
import { evaluatePreconditions, parseRange, parsePrefer } from './http-cond.js';
import { runReport } from './reports.js';
import { parseComponent } from './ical.js';
import { analyzeCalendar, CalendarError } from './calendar.js';
import { analyzeVcard, VcardError } from './vcard.js';
import { INBOX } from './inbox.js';
import { stripKnownTimezones, wantsNoTimezones } from './projection.js';
import { JCAL_TYPE, JCARD_TYPE, toJsonText, fromJsonText } from './jcal.js';
import { assertAvailability } from './availability.js';
import { planWrite, planDelete, outboxPost } from './schedule.js';

const DAV_HEADER = '1, 2, 3, extended-mkcol, access-control, calendar-access, calendar-auto-schedule, calendar-no-timezone, addressbook';
const OPTIONS_ALLOW = 'OPTIONS, GET, HEAD, POST, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK, PROPFIND, PROPPATCH, REPORT, MKCOL, MKCALENDAR, ACL';
const WRITE_METHODS = new Set(['ACL', 'PUT', 'DELETE', 'PROPPATCH', 'MKCOL', 'MKCALENDAR', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'POST']);
const MAX_DEAD_PROP_BYTES = 65_536;
const XML_BODY_LIMIT = 1024 * 1024;
const COLLECTION_URI = /^[A-Za-z0-9._~@+-]{1,128}$/;
const CALENDAR_COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL'];

const isObject = (r) => r.kind === 'calobj' || r.kind === 'card';
const isDavCollection = (r) => r.kind === 'calendar' || r.kind === 'addressbook';

function allowFor(r) {
  if (r.kind === 'inbox') return 'OPTIONS, PROPFIND, PROPPATCH, REPORT';
  if (r.kind === 'outbox') return 'OPTIONS, POST, PROPFIND';
  if (isObject(r)) return r.exists ? 'OPTIONS, GET, HEAD, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK, PROPFIND, PROPPATCH' : 'OPTIONS, PUT, LOCK';
  if (isDavCollection(r)) return r.exists ? 'OPTIONS, POST, PROPFIND, PROPPATCH, REPORT, DELETE, COPY, MOVE, LOCK, UNLOCK' : 'OPTIONS, MKCOL, MKCALENDAR, LOCK';
  return 'OPTIONS, GET, HEAD, PROPFIND';
}

function send(res, status, { headers = {}, body = null } = {}) {
  const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const out = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', DAV: DAV_HEADER, ...headers };
  if (buf) out['Content-Length'] = buf.length;
  else if (status !== 204 && status !== 304) out['Content-Length'] = 0;
  res.writeHead(status, out);
  res.end(buf);
}

const sendXml = (res, status, tree, headers = {}) =>
  send(res, status, { headers: { 'Content-Type': 'application/xml; charset=utf-8', ...headers }, body: serialize(tree) });

function sendMultistatus(ctx, res, tree) {
  const minimal = ctx.prefer.get('return') === 'minimal';
  const applied = [...(minimal ? ['return=minimal'] : []), ...(ctx.applied ?? [])];
  return sendXml(res, 207, minimal ? minimize(tree) : tree, applied.length ? { 'Preference-Applied': applied.join(', ') } : {});
}

/** Loads everything property rendering may need beyond the resource rows: locks, dead properties, quota usage. */
async function prepareProps(ctx, r, names = []) {
  await ensureLocks(ctx);
  if (r.segments.length) {
    ctx.deadProps = new Map();
    for (const row of await ctx.store.listDeadProps(ctx.user.id, pathKey(r.segments))) {
      if (!ctx.deadProps.has(row.path)) ctx.deadProps.set(row.path, new Map());
      ctx.deadProps.get(row.path).set(row.name, row.value);
    }
  }
  if (names.some((n) => QUOTA_PROPS.has(n))) {
    const byCollection = await ctx.store.collectionUsage(ctx.user.id);
    ctx.usage = { byCollection, total: [...byCollection.values()].reduce((a, b) => a + b, 0) };
  }
}

async function readBody(req, limit) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'Content-Encoding is not supported');
  }
  if (Number(req.headers['content-length']) > limit) {
    throw new HttpError(413, 'Payload Too Large', { headers: { Connection: 'close' } });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Payload Too Large', { headers: { Connection: 'close' } });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readXml(ctx) {
  const buf = await readBody(ctx.req, XML_BODY_LIMIT);
  if (!buf.length) return null;
  try {
    return parseXml(buf.toString('utf8'));
  } catch (err) {
    if (err instanceof XmlError) throw new HttpError(400, `Invalid XML: ${err.message}`);
    throw err;
  }
}

const INT32_MAX = 2 ** 31 - 1;

function columnValue(column, node) {
  if (column === 'sort_order') {
    const n = parseInt(node.text, 10);
    return Number.isFinite(n) && Math.abs(n) <= INT32_MAX ? n : null;
  }
  // PostgreSQL text columns cannot hold NUL characters.
  if (node.text.includes('\0')) throw new HttpError(400, 'Invalid character in property value');
  if (column === 'timezone' && node.text.trim()) {
    // RFC 4791 5.2.2: exactly one VTIMEZONE inside a VCALENDAR.
    let ok = false;
    try {
      const root = parseComponent(node.text);
      ok = root.name === 'VCALENDAR' && root.comps.length === 1 && root.comps[0].name === 'VTIMEZONE';
    } catch { /* reported below */ }
    if (!ok) throw davError(403, el(c('valid-calendar-data')));
  }
  return node.text;
}

// ---- method handlers ------------------------------------------------------

function get(ctx, res, r) {
  if (r.kind === 'root') {
    return send(res, 200, { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'nodedav CalDAV/CardDAV server\n' });
  }
  if (!isObject(r)) throw new HttpError(405, 'Method Not Allowed', { headers: { Allow: allowFor(r) } });
  if (!r.exists) throw new HttpError(404, 'Not Found');
  const o = r.object;
  const headers = { ETag: `"${o.etag}"`, 'Last-Modified': new Date(o.last_modified * 1000).toUTCString(), 'Accept-Ranges': 'bytes' };
  const verdict = evaluatePreconditions(ctx.req.headers, { etag: o.etag, lastModified: o.last_modified }, ctx.req.method);
  if (verdict === 412) throw new HttpError(412, 'Precondition Failed');
  if (verdict === 304) return send(res, 304, { headers });
  headers['Content-Type'] = r.kind === 'calobj' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8';
  let text = r.kind === 'calobj' && wantsNoTimezones(ctx.req.headers) ? stripKnownTimezones(o.data) : o.data;
  headers.Vary = 'Accept, CalDAV-Timezones';
  const accept = String(ctx.req.headers.accept ?? '').toLowerCase();
  const jsonType = r.kind === 'calobj' ? JCAL_TYPE : JCARD_TYPE;
  if (accept.includes(jsonType)) {
    try {
      text = toJsonText(text);
      headers['Content-Type'] = `${jsonType}; charset=utf-8`;
    } catch { /* unparseable data is served as stored */ }
  }
  const body = Buffer.from(text, 'utf8');
  const range = parseRange(ctx.req.headers, body.length, o.etag, o.last_modified);
  if (range === 'unsatisfiable') throw new HttpError(416, 'Range Not Satisfiable', { headers: { 'Content-Range': `bytes */${body.length}` } });
  if (range) {
    return send(res, 206, {
      headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}` },
      body: body.subarray(range.start, range.end + 1),
    });
  }
  return send(res, 200, { headers, body });
}

async function propfind(ctx, res, r) {
  const body = await readXml(ctx);
  if (!r.exists) throw new HttpError(404, 'Not Found');
  const depth = (ctx.req.headers.depth ?? 'infinity').trim().toLowerCase();
  if (depth === 'infinity') throw davError(403, el(d('propfind-finite-depth')));
  if (depth !== '0' && depth !== '1') throw new HttpError(400, 'Invalid Depth header');

  let mode = 'allprop';
  let names = [];
  if (body) {
    if (body.tag !== d('propfind')) throw new HttpError(400, 'Expected a propfind request body');
    const prop = childOf(body, d('prop'));
    if (childOf(body, d('propname'))) mode = 'propname';
    else if (prop) {
      mode = 'prop';
      names = prop.children.map((n) => n.tag);
    } else {
      names = childOf(body, d('include'))?.children.map((n) => n.tag) ?? [];
    }
  }
  const withData = names.some((t) => DATA_PROPS.has(t));
  const targets = [r];
  if (depth === '1' && r.isCollection) targets.push(...await listChildren(ctx, r, { withData }));
  if (depth === '1' && ctx.prefer.has('depth-noroot')) targets.shift();
  await prepareProps(ctx, r, names);
  const tree = multistatus(targets.map((t) => propResponse(ctx, t, mode, names)));
  const applied = [...(ctx.prefer.has('depth-noroot') && depth === '1' ? ['depth-noroot'] : [])];
  if (applied.length) ctx.applied = applied;
  return sendMultistatus(ctx, res, tree);
}

const IGNORED_CALENDAR_PROPS = new Set([c('calendar-free-busy-set')]);
const INBOX_SETTABLE = new Set([c('schedule-default-calendar-URL')]);

async function proppatch(ctx, res, r) {
  const root = await readXml(ctx);
  if (!root || root.tag !== d('propertyupdate')) throw new HttpError(400, 'Expected a propertyupdate request body');
  if (!r.exists) throw new HttpError(404, 'Not Found');
  assertUnlocked(ctx, r.segments);

  const ops = [];
  for (const action of root.children) {
    if (action.tag !== d('set') && action.tag !== d('remove')) continue;
    for (const p of childOf(action, d('prop'))?.children ?? []) {
      ops.push({ tag: p.tag, remove: action.tag === d('remove'), node: p });
    }
  }
  const writable = isDavCollection(r) ? WRITABLE[r.kind] : {};
  const ignored = r.kind === 'calendar' ? IGNORED_CALENDAR_PROPS : new Set();
  const deadCapable = isDavCollection(r) || isObject(r) || r.kind === 'inbox';
  // 'column' = stored on the collection row, 'ignore' = accepted no-op, 'dead' = arbitrary client property.
  const classify = (op) => {
    if (writable[op.tag]) return 'column';
    if (r.kind === 'inbox' && INBOX_SETTABLE.has(op.tag)) return 'dead';
    if (ignored.has(op.tag)) return 'ignore';
    if (Object.hasOwn(PROPS, op.tag) || !deadCapable) return 'protected';
    return 'dead';
  };
  const kinds = ops.map(classify);
  const failed = kinds.includes('protected');

  const propstats = [];
  if (!failed) {
    const updates = {};
    const sets = [];
    const removes = [];
    ops.forEach((op, i) => {
      if (kinds[i] === 'column') updates[writable[op.tag]] = op.remove ? null : columnValue(writable[op.tag], op.node);
      if (kinds[i] !== 'dead') return;
      if (op.remove) { removes.push(op.tag); return; }
      if (op.tag === c('calendar-availability')) {
        try {
          assertAvailability(op.node.text);
        } catch {
          throw davError(403, el(c('valid-calendar-data')));
        }
      }
      const value = freezeNode(op.node);
      if (Buffer.byteLength(value) > MAX_DEAD_PROP_BYTES || op.tag.length > 1000 || value.includes('\\u0000')) {
        throw new HttpError(413, 'Property value too large or invalid');
      }
      sets.push({ name: op.tag, value });
    });
    await ctx.store.transaction(async (tx) => {
      if (Object.keys(updates).length) await tx.updateCollection(r.collection.id, updates);
      if (sets.length || removes.length) await tx.setDeadProps(ctx.user.id, pathKey(r.segments), sets, removes);
    });
    propstats.push(propstat(200, ops.map((op) => el(op.tag))));
  } else {
    const forbidden = ops.filter((_, i) => kinds[i] === 'protected');
    const dependent = ops.filter((_, i) => kinds[i] !== 'protected');
    propstats.push(propstat(403, forbidden.map((op) => el(op.tag)), el(d('cannot-modify-protected-property'))));
    if (dependent.length) propstats.push(propstat(424, dependent.map((op) => el(op.tag))));
  }
  return sendXml(res, 207, multistatus(el(d('response'), null, el(d('href'), null, hrefOf(ctx, r)), propstats)));
}

// RFC 3744 8.1: ACLs here are fixed by ownership, so any attempt to change them hits a protected ACE.
async function setAcl(ctx, res, r) {
  const root = await readXml(ctx);
  if (!r.exists) throw new HttpError(404, 'Not Found');
  if (root?.tag !== d('acl')) throw new HttpError(400, 'Expected an acl request body');
  throw davError(403, el(d('no-protected-ace-conflict')));
}

async function report(ctx, res, r) {
  const root = await readXml(ctx);
  if (!root) throw new HttpError(400, 'Missing report body');
  if (!r.exists) throw new HttpError(404, 'Not Found');
  await prepareProps(ctx, r);
  const result = await runReport(ctx, r, root);
  if (result.raw?.tree) return sendXml(res, 200, result.raw.tree);
  if (result.raw) return send(res, 200, { headers: { 'Content-Type': result.raw.contentType }, body: result.raw.body });
  return sendMultistatus(ctx, res, result);
}

async function mkcol(ctx, res, r, method) {
  const root = await readXml(ctx);
  if (!isDavCollection(r)) throw new HttpError(r.exists ? 405 : 403, 'Collections can only be created inside a calendar or address book home', { headers: { Allow: allowFor(r) } });
  if (r.exists) throw new HttpError(405, 'Resource already exists', { headers: { Allow: allowFor(r) } });
  if (method === 'MKCALENDAR' && r.kind !== 'calendar') throw new HttpError(403, 'MKCALENDAR is only valid inside a calendar home');

  const uri = r.segments.at(-1);
  if (!COLLECTION_URI.test(uri)) throw new HttpError(400, 'Invalid collection name');
  assertUnlocked(ctx, r.segments, { membership: true });

  const props = [];
  if (root) {
    if (root.tag !== (method === 'MKCALENDAR' ? c('mkcalendar') : d('mkcol'))) throw new HttpError(400, `Unexpected request body for ${method}`);
    for (const set of childrenOf(root, d('set'))) props.push(...(childOf(set, d('prop'))?.children ?? []));
  }
  const resourceType = props.find((p) => p.tag === d('resourcetype'));
  if (resourceType) {
    const wanted = r.kind === 'calendar' ? c('calendar') : card('addressbook');
    if (!childOf(resourceType, wanted)) throw davError(403, el(d('valid-resourcetype')));
  }

  const fields = {};
  for (const p of props) {
    const column = WRITABLE[r.kind][p.tag];
    if (column) fields[column] = columnValue(column, p);
    else if (r.kind === 'calendar' && p.tag === c('supported-calendar-component-set')) {
      const names = childrenOf(p, c('comp')).map((n) => n.attrs.name?.toUpperCase()).filter((n) => CALENDAR_COMPONENTS.includes(n));
      if (names.length) fields.components = names.join(',');
    }
  }
  try {
    await ctx.store.createCollection(ctx.user.id, r.kind, uri, fields);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(405, 'Resource already exists', { headers: { Allow: allowFor(r) } });
    throw err;
  }
  return send(res, 201, { headers: { Location: hrefOf(ctx, r) } });
}

function validateObject(ctx, r, data) {
  if (r.kind === 'calobj') {
    let meta;
    try {
      meta = analyzeCalendar(data, ctx.config);
    } catch (err) {
      if (err instanceof CalendarError) throw davError(403, el(c(err.condition)));
      throw err;
    }
    if (!r.collection.components.split(',').includes(meta.componentType)) {
      throw davError(403, el(c('supported-calendar-component')));
    }
    return { ...meta, uidConflict: c('no-uid-conflict') };
  }
  try {
    const { uid } = analyzeVcard(data);
    return { uid, componentType: 'VCARD', uidConflict: card('no-uid-conflict') };
  } catch (err) {
    if (err instanceof VcardError) throw davError(403, el(card('valid-address-data')));
    throw err;
  }
}

async function decodeObjectBody(ctx, r, buf) {
  const invalidData = () => davError(403, el(r.kind === 'calobj' ? c('valid-calendar-data') : card('valid-address-data')));
  let data;
  try {
    data = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw invalidData();
  }
  // PostgreSQL text columns cannot hold NUL characters.
  if (data.includes('\0')) throw invalidData();
  const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === JCAL_TYPE || type === JCARD_TYPE) {
    try {
      return fromJsonText(data);
    } catch {
      throw invalidData();
    }
  }
  return data;
}

const quotaExceeded = () => davError(507, el(d('quota-not-exceeded')));

/** Creates or replaces one object; `headers` carry the conditional request headers. */
async function storeObject(ctx, r, data, headers) {
  const uri = r.segments.at(-1);
  const meta = validateObject(ctx, r, data);
  const size = Buffer.byteLength(data);
  return ctx.store.transaction(async (tx) => {
    if (!(await tx.lockCollection(r.collection.id))) throw new HttpError(404, 'Not Found');
    const existing = await tx.getObject(r.collection.id, uri);
    const verdict = evaluatePreconditions(headers, { etag: existing?.etag ?? null, lastModified: existing?.last_modified ?? null }, 'PUT');
    if (verdict !== 200) throw new HttpError(412, 'Precondition Failed');
    if (meta.uid) {
      const other = await tx.findByUid(r.collection.id, meta.uid);
      if (other && other.uri !== uri) {
        const href = hrefFor(ctx.base, [...r.segments.slice(0, -1), other.uri], false);
        throw davError(409, el(meta.uidConflict, null, el(d('href'), null, href)));
      }
    }
    if (ctx.config.quotaBytes && size > (existing?.size ?? 0)
      && (await tx.usedBytes({ userId: ctx.user.id })) + size - (existing?.size ?? 0) > ctx.config.quotaBytes) {
      throw quotaExceeded();
    }
    return tx.putObject(r.collection, uri, data, meta);
  });
}

async function put(ctx, res, r) {
  if (!isObject(r)) throw new HttpError(isDavCollection(r) ? 405 : 403, 'Cannot PUT here', { headers: { Allow: allowFor(r) } });
  if (!r.collection) throw new HttpError(409, 'Parent collection does not exist');
  if (r.segments.at(-1).length > 255) throw new HttpError(400, 'Resource name too long');
  if (r.kind === 'calobj' && r.collection.uri === INBOX) throw new HttpError(403, 'The scheduling inbox only receives messages from the server');
  assertUnlocked(ctx, r.segments, { membership: !r.exists });
  const data = await decodeObjectBody(ctx, r, await readBody(ctx.req, ctx.config.maxResourceSize));
  const plan = r.kind === 'calobj' ? await planWrite(ctx, r.object?.data ?? null, data) : null;
  const result = await storeObject(ctx, r, plan?.data ?? data, ctx.req.headers);
  await plan?.run();
  // A body the server changed (SCHEDULE-STATUS) must not come back with an ETag the client would take for its own copy.
  const headers = plan && plan.data !== data ? {} : { ETag: `"${result.etag}"` };
  return send(res, result.created ? 201 : 204, { headers });
}

// RFC 5995: POST to a collection creates a member with a server-chosen name.
async function post(ctx, res, r) {
  if (r.kind === 'outbox') return postOutbox(ctx, res);
  if (!isDavCollection(r) || !r.exists) throw new HttpError(405, 'Method Not Allowed', { headers: { Allow: allowFor(r) } });
  const cal = r.kind === 'calendar';
  const type = (ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== (cal ? 'text/calendar' : 'text/vcard')) throw new HttpError(415, `Expected ${cal ? 'text/calendar' : 'text/vcard'}`);
  const member = objectResource(r, { uri: `${randomUUID()}${cal ? '.ics' : '.vcf'}` });
  member.exists = false;
  member.object = null;
  assertUnlocked(ctx, member.segments, { membership: true });
  const data = await decodeObjectBody(ctx, member, await readBody(ctx.req, ctx.config.maxResourceSize));
  const plan = cal ? await planWrite(ctx, null, data) : null;
  const result = await storeObject(ctx, member, plan?.data ?? data, { 'if-none-match': '*' });
  await plan?.run();
  const headers = { Location: hrefOf(ctx, member), ...(plan && plan.data !== data ? {} : { ETag: `"${result.etag}"` }) };
  return send(res, 201, { headers });
}

// RFC 6638 6: a scheduling message POSTed to the outbox is delivered to its recipients.
async function postOutbox(ctx, res) {
  const type = (ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/calendar') throw new HttpError(415, 'Expected text/calendar');
  const buf = await readBody(ctx.req, ctx.config.maxResourceSize);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw davError(403, el(c('valid-scheduling-message')));
  }
  return sendXml(res, 200, await outboxPost(ctx, text));
}

async function del(ctx, res, r) {
  if (!r.exists && !isObject(r) && !isDavCollection(r)) throw new HttpError(403, 'Forbidden');
  if (!isObject(r) && !isDavCollection(r)) throw new HttpError(403, 'Forbidden');
  if (!r.exists) throw new HttpError(404, 'Not Found');
  assertUnlocked(ctx, r.segments, { membership: true, subtree: true });
  if (isDavCollection(r)) {
    await ctx.store.deleteCollection(r.collection.id);
  } else {
    const removed = await ctx.store.transaction(async (tx) => {
      if (!(await tx.lockCollection(r.collection.id))) throw new HttpError(404, 'Not Found');
      const current = await tx.getObject(r.collection.id, r.segments.at(-1));
      if (!current) throw new HttpError(404, 'Not Found');
      const verdict = evaluatePreconditions(ctx.req.headers, { etag: current.etag, lastModified: current.last_modified }, 'DELETE');
      if (verdict !== 200) throw new HttpError(412, 'Precondition Failed');
      await tx.deleteObject(r.collection.id, current.uri);
      return current;
    });
    if (r.kind === 'calobj' && r.collection.uri !== INBOX) await (await planDelete(ctx, removed.data))();
  }
  await ctx.store.deletePathState(ctx.user.id, pathKey(r.segments));
  return send(res, 204);
}

// ---- COPY / MOVE (RFC 4918 9.8-9.9) ---------------------------------------

function destinationOf(ctx) {
  const header = ctx.req.headers.destination;
  if (!header) throw new HttpError(400, 'Destination header is required');
  let url;
  try {
    url = new URL(header, `http://${ctx.req.headers.host ?? 'localhost'}`);
  } catch {
    throw new HttpError(400, 'Invalid Destination header');
  }
  if (ctx.req.headers.host && url.host !== ctx.req.headers.host) throw new HttpError(502, 'Destination is on another server');
  try {
    return parsePath(url.pathname, ctx.base);
  } catch (err) {
    if (err.status === 404) throw new HttpError(502, 'Destination is outside this server');
    throw err;
  }
}

async function copyMove(ctx, res, r, method) {
  const move = method === 'MOVE';
  if (!isObject(r) && !isDavCollection(r)) throw new HttpError(403, 'Only calendar and address book resources can be copied');
  if (!r.exists) throw new HttpError(404, 'Not Found');

  const overwriteHeader = (ctx.req.headers.overwrite ?? 'T').trim().toUpperCase();
  if (overwriteHeader !== 'T' && overwriteHeader !== 'F') throw new HttpError(400, 'Invalid Overwrite header');
  const overwrite = overwriteHeader === 'T';
  const depth = (ctx.req.headers.depth ?? 'infinity').trim().toLowerCase();
  if (depth !== '0' && depth !== 'infinity') throw new HttpError(400, 'Invalid Depth header');
  if (move && depth !== 'infinity') throw new HttpError(400, 'MOVE only supports Depth: infinity');

  const dsegs = destinationOf(ctx);
  const dr = await resolve(ctx, dsegs);
  if (!dr || dr.kind !== r.kind) throw new HttpError(403, 'Destination must be the same kind of resource');
  if (pathKey(dr.segments) === pathKey(r.segments)) throw new HttpError(403, 'Source and destination are the same');
  if (dr.kind === 'calobj' && dr.collection?.uri === INBOX) throw new HttpError(403, 'The scheduling inbox only receives messages from the server');
  const dstName = dsegs.at(-1);

  assertUnlocked(ctx, dr.segments, { membership: true, subtree: dr.exists });
  if (move) assertUnlocked(ctx, r.segments, { membership: true, subtree: true });
  if (dr.exists && !overwrite) throw new HttpError(412, 'Destination exists and Overwrite is F');

  if (isObject(r)) {
    if (!dr.collection) throw new HttpError(409, 'Destination collection does not exist');
    if (dstName.length > 255) throw new HttpError(400, 'Resource name too long');
    const srcUri = r.segments.at(-1);
    const result = await ctx.store.transaction(async (tx) => {
      const ids = [...new Set([r.collection.id, dr.collection.id])].sort((a, b) => a - b);
      for (const id of ids) if (!(await tx.lockCollection(id))) throw new HttpError(404, 'Not Found');
      const src = await tx.getObject(r.collection.id, srcUri);
      if (!src) throw new HttpError(404, 'Not Found');
      const existing = await tx.getObject(dr.collection.id, dstName);
      if (existing && !overwrite) throw new HttpError(412, 'Destination exists and Overwrite is F');
      const meta = validateObject(ctx, dr, src.data);
      if (meta.uid) {
        const other = await tx.findByUid(dr.collection.id, meta.uid);
        const vacated = move && other?.uri === srcUri && dr.collection.id === r.collection.id;
        if (other && other.uri !== dstName && !vacated) {
          throw davError(409, el(meta.uidConflict, null, el(d('href'), null, hrefFor(ctx.base, [...dr.segments.slice(0, -1), other.uri], false))));
        }
      }
      if (!move && ctx.config.quotaBytes && src.size > (existing?.size ?? 0)
        && (await tx.usedBytes({ userId: ctx.user.id })) + src.size - (existing?.size ?? 0) > ctx.config.quotaBytes) {
        throw quotaExceeded();
      }
      const stored = await tx.putObject(dr.collection, dstName, src.data, meta);
      if (move) await tx.deleteObject(r.collection.id, srcUri);
      return { ...stored, replaced: !!existing };
    });
    await carryPathState(ctx, r, dr, move, result.replaced);
    return send(res, result.replaced ? 204 : 201, { headers: { ETag: `"${result.etag}"` } });
  }

  if (!COLLECTION_URI.test(dstName)) throw new HttpError(400, 'Invalid collection name');
  const objKind = r.kind === 'calendar' ? 'calobj' : 'card';
  await ctx.store.transaction(async (tx) => {
    if (dr.exists) await tx.deleteCollection(dr.collection.id);
    if (move) {
      await tx.renameCollection(r.collection.id, dstName);
      return;
    }
    const copy = await tx.createCollection(ctx.user.id, r.kind, dstName, r.collection);
    if (depth === '0') return;
    const rows = await tx.listObjects(r.collection.id, { withData: true });
    if (ctx.config.quotaBytes
      && (await tx.usedBytes({ userId: ctx.user.id })) + rows.reduce((n, row) => n + row.size, 0) > ctx.config.quotaBytes) {
      throw quotaExceeded();
    }
    for (const row of rows) await tx.putObject(copy, row.uri, row.data, validateObject(ctx, { kind: objKind, collection: copy }, row.data));
  });
  await carryPathState(ctx, r, dr, move, dr.exists);
  return send(res, dr.exists ? 204 : 201);
}

/** Dead properties follow COPY/MOVE; locks never do (RFC 4918 7.7). A replaced destination loses its own state. */
async function carryPathState(ctx, r, dr, move, replaced) {
  const from = pathKey(r.segments);
  const to = pathKey(dr.segments);
  if (replaced) await ctx.store.deletePathState(ctx.user.id, to);
  await ctx.store.copyDeadProps(ctx.user.id, from, to);
  if (move) await ctx.store.deletePathState(ctx.user.id, from);
}

// ---- LOCK / UNLOCK (RFC 4918 9.10-9.11) ---------------------------------------

async function lock(ctx, res, r) {
  const body = await readXml(ctx);
  const path = pathKey(r.segments);
  const timeout = parseTimeout(ctx.req.headers.timeout, ctx.config);

  if (!body) {
    const held = ctx.locks.find((l) => ctx.submitted.has(l.token) && lockCovers(l, path));
    if (!held) throw new HttpError(412, 'No matching lock token in the If header');
    const refreshed = await ctx.store.refreshLock(held.token, timeout);
    return sendXml(res, 200, lockProp(ctx, refreshed));
  }
  if (body.tag !== d('lockinfo')) throw new HttpError(400, 'Expected a lockinfo request body');
  const scope = childOf(childOf(body, d('lockscope')), d('exclusive')) ? 'exclusive' : childOf(childOf(body, d('lockscope')), d('shared')) ? 'shared' : null;
  if (!scope || !childOf(childOf(body, d('locktype')), d('write'))) throw new HttpError(400, 'Only exclusive or shared write locks are supported');
  if (!isObject(r) && !isDavCollection(r)) throw new HttpError(403, 'Only calendar and address book resources can be locked');
  if (!r.exists && (!isObject(r) || !r.collection)) throw new HttpError(409, 'Parent collection does not exist');

  const depthHeader = (ctx.req.headers.depth ?? 'infinity').trim().toLowerCase();
  if (depthHeader !== '0' && depthHeader !== 'infinity') throw new HttpError(400, 'Invalid Depth header');
  const deep = r.isCollection && depthHeader === 'infinity';
  const conflicts = conflictingLocks(ctx, path, { exclusive: scope === 'exclusive', deep });
  if (conflicts.length) {
    const hrefs = conflicts.map((l) => el(d('href'), null, hrefFor(ctx.base, l.path.split('/'), l.path.split('/').length <= 3)));
    throw davError(423, el(d('no-conflicting-lock'), null, hrefs));
  }
  const ownerNode = childOf(body, d('owner'));
  const row = await ctx.store.createLock({
    token: newToken(), userId: ctx.user.id, path, depth: deep ? -1 : 0, exclusive: scope === 'exclusive',
    owner: ownerNode ? freezeNode(ownerNode) : null, timeout,
  });
  return sendXml(res, r.exists ? 200 : 201, lockProp(ctx, row), { 'Lock-Token': `<${row.token}>` });
}

const lockProp = (ctx, row) => el(d('prop'), null, el(d('lockdiscovery'), null, activeLock(ctx, row)));

async function unlock(ctx, res, r) {
  const token = /^<([^>]+)>$/.exec((ctx.req.headers['lock-token'] ?? '').trim())?.[1];
  if (!token) throw new HttpError(400, 'Lock-Token header is required');
  const held = ctx.locks.find((l) => l.token === token && lockCovers(l, pathKey(r.segments)));
  if (!held) throw davError(409, el(d('lock-token-matches-request-uri')));
  await ctx.store.deleteLock(token);
  return send(res, 204);
}

// ---- entry point ----------------------------------------------------------

export function createHandler({ store, config, auth }) {
  const base = config.basePath;

  async function dispatch(req, res, info) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'Bad Request');
    }
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/.well-known/caldav' || pathname === '/.well-known/carddav') {
      return send(res, 301, { headers: { Location: `${base}/` } });
    }
    if (method === 'OPTIONS') return send(res, 200, { headers: { Allow: OPTIONS_ALLOW } });
    if (base && pathname === '/' && (method === 'GET' || method === 'HEAD')) {
      return send(res, 302, { headers: { Location: `${base}/` } });
    }

    const user = await auth.authenticate(req);
    if (!user) throw auth.challenge();
    info.user = user.username;

    const ctx = { req, store, user, base, config, prefer: parsePrefer(req.headers.prefer) };
    const r = await resolve(ctx, parsePath(pathname, base));
    if (!r) throw new HttpError(404, 'Not Found');
    if (WRITE_METHODS.has(method)) await ensureLocks(ctx);
    await checkIf(ctx, r);

    switch (method) {
      case 'GET':
      case 'HEAD': return get(ctx, res, r);
      case 'POST': return post(ctx, res, r);
      case 'PUT': return put(ctx, res, r);
      case 'DELETE': return del(ctx, res, r);
      case 'COPY':
      case 'MOVE': return copyMove(ctx, res, r, method);
      case 'LOCK': return lock(ctx, res, r);
      case 'UNLOCK': return unlock(ctx, res, r);
      case 'PROPFIND': return propfind(ctx, res, r);
      case 'PROPPATCH': return proppatch(ctx, res, r);
      case 'REPORT': return report(ctx, res, r);
      case 'ACL': return setAcl(ctx, res, r);
      case 'MKCOL':
      case 'MKCALENDAR': return mkcol(ctx, res, r, method);
      default: throw new HttpError(501, `${method} is not supported`);
    }
  }

  function sendError(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.xml) return sendXml(res, err.status, err.xml, err.headers);
      return send(res, err.status, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...err.headers },
        body: `${err.message || err.status}\n`,
      });
    }
    console.error(err);
    return send(res, 500, { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Internal Server Error\n' });
  }

  return async function handler(req, res) {
    const started = performance.now();
    const info = { user: null };
    if (config.logRequests) {
      res.on('finish', () => {
        const ms = (performance.now() - started).toFixed(1);
        console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${info.user ?? '-'} ${req.method} ${JSON.stringify(req.url)} ${res.statusCode} ${ms}ms`);
      });
    }
    try {
      await dispatch(req, res, info);
    } catch (err) {
      sendError(res, err);
    }
  };
}
