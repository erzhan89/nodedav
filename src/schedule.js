// CalDAV scheduling (RFC 6638) between users of this server: implicit scheduling on PUT/DELETE, iTIP delivery to
// inboxes with auto-processing, and the outbox POST (free-busy lookups and explicit iTIP messages).
import { randomUUID } from 'node:crypto';
import { c, d } from './ns.js';
import { el } from './xml.js';
import { davError } from './errors.js';
import { parseComponent, serializeComponent, getProp, getProps } from './ical.js';
import { analyzeCalendar } from './calendar.js';
import { busyFromData, buildFreeBusy } from './freebusy.js';
import { parseDateFields, fieldsToUtc } from './dates.js';
import { hrefFor } from './resources.js';
import { INBOX, ensureInbox } from './inbox.js';
import { unavailablePeriods } from './availability.js';

const MAX_RECIPIENTS = 100;
const noop = async () => {};

// ---- calendar user addresses -------------------------------------------------

function normalize(value) {
  const v = value.trim();
  if (/^mailto:/i.test(v)) return `mailto:${v.slice(7).trim().toLowerCase()}`;
  try {
    return decodeURIComponent(new URL(v, 'http://localhost').pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return v.toLowerCase();
  }
}

export function addressesOf(ctx, user) {
  const set = new Set([normalize(hrefFor(ctx.base, ['principals', user.username], true))]);
  if (user.email) set.add(normalize(`mailto:${user.email}`));
  return set;
}

export async function findUser(ctx, address) {
  const n = normalize(address);
  if (n.startsWith('mailto:')) return ctx.store.getUserByEmail(n.slice(7));
  const prefix = `${ctx.base.toLowerCase()}/principals/`;
  if (!n.startsWith(prefix)) return null;
  const name = n.slice(prefix.length);
  return name && !name.includes('/') ? ctx.store.getUserByName(name) : null;
}

// ---- iTIP message construction --------------------------------------------------

const tryParse = (text) => {
  try { return parseComponent(text); } catch { return null; }
};
const setProp = (comp, name, value, params = Object.create(null)) => {
  comp.props = comp.props.filter((p) => p.name !== name);
  comp.props.push({ name, params, value, group: null });
};
const clone = (tree) => JSON.parse(JSON.stringify(tree), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && k === 'params' ? Object.assign(Object.create(null), v) : v));
const recurrenceKey = (comp) => getProp(comp, 'RECURRENCE-ID')?.value.trim() ?? '';
const events = (root) => root.comps.filter((x) => x.name === 'VEVENT');
const agentIsServer = (p) => (p.params['SCHEDULE-AGENT']?.[0] ?? 'SERVER').toUpperCase() === 'SERVER';
const partstat = (p) => (p?.params.PARTSTAT?.[0] ?? 'NEEDS-ACTION').toUpperCase();
const sequenceOf = (root) => Math.max(0, ...events(root).map((e) => parseInt(getProp(e, 'SEQUENCE')?.value, 10) || 0));

function withMethod(root, method) {
  const tree = clone(root);
  tree.props = tree.props.filter((p) => p.name !== 'METHOD');
  const at = tree.props.findIndex((p) => p.name === 'VERSION') + 1;
  tree.props.splice(at, 0, { name: 'METHOD', params: Object.create(null), value: method, group: null });
  for (const ev of events(tree)) {
    for (const p of ev.props) {
      delete p.params['SCHEDULE-STATUS'];
      delete p.params['SCHEDULE-FORCE-SEND'];
    }
  }
  return tree;
}

const attendeesOf = (root) => {
  const out = new Map();
  for (const ev of events(root)) {
    for (const p of getProps(ev, 'ATTENDEE')) if (!out.has(normalize(p.value))) out.set(normalize(p.value), p);
  }
  return out;
};

function replyFor(root, organizer, mine, forcedPartstat = null) {
  const tree = { name: 'VCALENDAR', comps: [], props: [] };
  for (const name of ['VERSION', 'PRODID']) {
    const p = getProp(root, name);
    if (p) tree.props.push(p);
  }
  tree.props.push({ name: 'METHOD', params: Object.create(null), value: 'REPLY', group: null });
  for (const ev of events(root)) {
    const attendee = getProps(ev, 'ATTENDEE').find((p) => mine.has(normalize(p.value)));
    if (!attendee) continue;
    const reply = { name: 'VEVENT', comps: [], props: [] };
    for (const name of ['UID', 'DTSTAMP', 'SEQUENCE', 'RECURRENCE-ID', 'SUMMARY', 'DTSTART']) {
      const p = getProp(ev, name);
      if (p) reply.props.push(p);
    }
    reply.props.push(organizer);
    const own = clone({ p: attendee }).p;
    delete own.params['SCHEDULE-STATUS'];
    if (forcedPartstat) own.params.PARTSTAT = [forcedPartstat];
    reply.props.push(own);
    tree.comps.push(reply);
  }
  return tree.comps.length ? serializeComponent(tree) : null;
}

// ---- delivery ---------------------------------------------------------------

async function findCopy(ctx, user, uid) {
  for (const col of await ctx.store.listCollections(user.id, 'calendar')) {
    if (col.uri === INBOX) continue;
    const hit = await ctx.store.findByUid(col.id, uid);
    if (hit) return { col, row: await ctx.store.getObject(col.id, hit.uri) };
  }
  return null;
}

async function defaultCalendar(ctx, user) {
  const { store } = ctx;
  const inboxPath = `calendars/${user.username}/${INBOX}`;
  const stored = (await store.listDeadProps(user.id, inboxPath)).find((p) => p.path === inboxPath && p.name === c('schedule-default-calendar-URL'));
  if (stored) {
    try {
      const href = JSON.parse(stored.value).children.find((ch) => ch.tag === d('href'))?.text ?? '';
      const uri = decodeURIComponent(href.trim().replace(/\/+$/, '').split('/').pop());
      const col = uri && uri !== INBOX ? await store.getCollection(user.id, 'calendar', uri) : null;
      if (col?.components.includes('VEVENT')) return col;
    } catch { /* fall back to the default calendar */ }
  }
  const named = await store.getCollection(user.id, 'calendar', 'default');
  if (named?.components.includes('VEVENT')) return named;
  return (await store.listCollections(user.id, 'calendar')).find((col) => col.uri !== INBOX && col.components.includes('VEVENT')) ?? null;
}

async function writeCopy(ctx, col, uri, tree) {
  const data = serializeComponent(tree);
  let meta;
  try {
    meta = analyzeCalendar(data, ctx.config);
  } catch {
    return;
  }
  await ctx.store.transaction(async (tx) => {
    if (await tx.lockCollection(col.id)) await tx.putObject(col, uri, data, meta);
  });
}

/** Applies a delivered message to the recipient's own copy of the event, as sabre/dav and CalendarServer do. */
async function autoProcess(ctx, user, tree, method) {
  const comps = events(tree);
  const uid = comps.length && getProp(comps[0], 'UID')?.value;
  if (!uid) return;
  const copy = await findCopy(ctx, user, uid);
  const mine = addressesOf(ctx, user);

  if (method === 'REQUEST') {
    const incoming = withMethod(tree, 'REQUEST');
    incoming.props = incoming.props.filter((p) => p.name !== 'METHOD');
    if (copy) {
      const existing = parseComponent(copy.row.data);
      if (sequenceOf(incoming) < sequenceOf(existing)) return;
      const previous = new Map(events(existing).map((ev) => [recurrenceKey(ev), getProps(ev, 'ATTENDEE').find((p) => mine.has(normalize(p.value)))]));
      for (const ev of events(incoming)) {
        const kept = previous.get(recurrenceKey(ev));
        const own = getProps(ev, 'ATTENDEE').find((p) => mine.has(normalize(p.value)));
        if (kept && own && kept.params.PARTSTAT) own.params.PARTSTAT = kept.params.PARTSTAT;
      }
      await writeCopy(ctx, copy.col, copy.row.uri, incoming);
      return;
    }
    const target = await defaultCalendar(ctx, user);
    if (target) await writeCopy(ctx, target, `${randomUUID()}.ics`, incoming);
  } else if (method === 'CANCEL' && copy) {
    const existing = parseComponent(copy.row.data);
    const keys = new Set(comps.map(recurrenceKey));
    for (const ev of events(existing)) if (keys.has('') || keys.has(recurrenceKey(ev))) setProp(ev, 'STATUS', 'CANCELLED');
    await writeCopy(ctx, copy.col, copy.row.uri, existing);
  } else if (method === 'REPLY' && copy) {
    const existing = parseComponent(copy.row.data);
    for (const reply of comps) {
      const target = events(existing).find((ev) => recurrenceKey(ev) === recurrenceKey(reply));
      if (!target) continue;
      for (const answer of getProps(reply, 'ATTENDEE')) {
        const match = getProps(target, 'ATTENDEE').find((p) => normalize(p.value) === normalize(answer.value));
        if (match && answer.params.PARTSTAT) match.params.PARTSTAT = answer.params.PARTSTAT;
      }
    }
    await writeCopy(ctx, copy.col, copy.row.uri, existing);
  }
}

/** Puts an iTIP message into the recipient's inbox, then applies it to their calendar. */
export async function deliver(ctx, user, text) {
  const tree = parseComponent(text);
  const method = getProp(tree, 'METHOD')?.value.trim().toUpperCase();
  const first = tree.comps.find((x) => x.name !== 'VTIMEZONE');
  const inbox = await ensureInbox(ctx.store, user.id);
  await ctx.store.transaction(async (tx) => {
    if (!(await tx.lockCollection(inbox.id))) return;
    await tx.putObject(inbox, `${randomUUID()}.ics`, text, {
      componentType: first?.name ?? 'VEVENT', uid: first && getProp(first, 'UID')?.value, firstOccurrence: null, lastOccurrence: null,
    });
  });
  if (first?.name === 'VEVENT') await autoProcess(ctx, user, tree, method);
}

const deliverAll = (ctx, jobs) => async () => {
  for (const { user, text } of jobs) {
    try {
      await deliver(ctx, user, text);
    } catch (err) {
      console.error('scheduling delivery failed:', err);
    }
  }
};

// ---- implicit scheduling ---------------------------------------------------------

const suppressed = (ctx) => String(ctx.req.headers['schedule-reply'] ?? '').trim().toUpperCase() === 'F';

/**
 * Decides what a calendar object change implies (RFC 6638 3.2). Returns the data to store (the server may add
 * SCHEDULE-STATUS) and a function that performs the deliveries once the change is committed.
 */
export async function planWrite(ctx, oldData, newData) {
  const unchanged = { data: newData, run: noop };
  if (suppressed(ctx) || oldData === newData) return unchanged;
  const root = tryParse(newData);
  const organizer = root && events(root).map((ev) => getProp(ev, 'ORGANIZER')).find(Boolean);
  if (!organizer || !agentIsServer(organizer)) return unchanged;
  const old = oldData ? tryParse(oldData) : null;
  const me = addressesOf(ctx, ctx.user);
  const organizerAddress = normalize(organizer.value);
  const jobs = [];

  if (me.has(organizerAddress)) {
    const message = serializeComponent(withMethod(root, 'REQUEST'));
    let modified = false;
    for (const [address, att] of attendeesOf(root)) {
      if (address === organizerAddress || me.has(address) || !agentIsServer(att)) continue;
      const user = await findUser(ctx, att.value);
      const status = user ? '1.2' : '5.3';
      if (att.params['SCHEDULE-STATUS']?.[0] !== status) { att.params['SCHEDULE-STATUS'] = [status]; modified = true; }
      if (user) jobs.push({ user, text: message });
    }
    if (old) {
      const remaining = attendeesOf(root);
      for (const [address, att] of attendeesOf(old)) {
        if (remaining.has(address) || address === organizerAddress || !agentIsServer(att)) continue;
        const user = await findUser(ctx, att.value);
        if (user) jobs.push({ user, text: cancellation(old, address) });
      }
    }
    return { data: modified ? serializeComponent(root) : newData, run: deliverAll(ctx, jobs) };
  }

  const before = new Map(old ? events(old).map((ev) => [recurrenceKey(ev), getProps(ev, 'ATTENDEE').find((p) => me.has(normalize(p.value)))]) : []);
  const changed = events(root).some((ev) => {
    const own = getProps(ev, 'ATTENDEE').find((p) => me.has(normalize(p.value)));
    return own && partstat(own) !== 'NEEDS-ACTION' && partstat(own) !== partstat(before.get(recurrenceKey(ev)));
  });
  if (!changed) return unchanged;
  const recipient = await findUser(ctx, organizer.value);
  const text = recipient && recipient.id !== ctx.user.id ? replyFor(root, organizer, me) : null;
  if (text) jobs.push({ user: recipient, text });
  return { data: newData, run: deliverAll(ctx, jobs) };
}

function cancellation(root, onlyAttendee = null) {
  const tree = withMethod(root, 'CANCEL');
  const next = sequenceOf(root) + 1;
  for (const ev of events(tree)) {
    setProp(ev, 'STATUS', 'CANCELLED');
    setProp(ev, 'SEQUENCE', String(next));
    if (onlyAttendee) ev.props = ev.props.filter((p) => p.name !== 'ATTENDEE' || normalize(p.value) === onlyAttendee);
  }
  return serializeComponent(tree);
}

/** What deleting an object implies: the organizer cancels for everyone, an attendee declines. */
export async function planDelete(ctx, oldData) {
  if (suppressed(ctx)) return noop;
  const root = tryParse(oldData);
  const organizer = root && events(root).map((ev) => getProp(ev, 'ORGANIZER')).find(Boolean);
  if (!organizer || !agentIsServer(organizer)) return noop;
  const me = addressesOf(ctx, ctx.user);
  const jobs = [];
  if (me.has(normalize(organizer.value))) {
    const text = cancellation(root);
    for (const [address, att] of attendeesOf(root)) {
      if (me.has(address) || !agentIsServer(att)) continue;
      const user = await findUser(ctx, att.value);
      if (user) jobs.push({ user, text });
    }
  } else {
    const recipient = await findUser(ctx, organizer.value);
    const text = recipient && recipient.id !== ctx.user.id ? replyFor(root, organizer, me, 'DECLINED') : null;
    if (text) jobs.push({ user: recipient, text });
  }
  return deliverAll(ctx, jobs);
}

// ---- free-busy and the outbox (RFC 6638 5, 6) --------------------------------------

async function isTransparent(ctx, user, col) {
  const path = `calendars/${user.username}/${col.uri}`;
  const row = (await ctx.store.listDeadProps(user.id, path)).find((p) => p.path === path && p.name === c('schedule-calendar-transp'));
  return Boolean(row && JSON.parse(row.value).children.some((ch) => ch.tag === c('transparent')));
}

export async function freeBusyOf(ctx, user, start, end) {
  const data = [];
  for (const col of await ctx.store.listCollections(user.id, 'calendar')) {
    if (col.uri === INBOX || await isTransparent(ctx, user, col)) continue;
    const rows = await ctx.store.listObjects(col.id, { withData: true, componentType: 'VEVENT', rangeStart: start, rangeEnd: end });
    data.push(...rows.map((row) => row.data));
  }
  const inboxPath = `calendars/${user.username}/${INBOX}`;
  const stored = (await ctx.store.listDeadProps(user.id, inboxPath)).find((p) => p.path === inboxPath && p.name === c('calendar-availability'));
  const availability = stored ? JSON.parse(stored.value).text : '';
  return [...busyFromData(data, start, end), ...(availability ? unavailablePeriods(availability, start, end) : [])];
}

const SUCCESS = '2.0;Success';
const INVALID_USER = '3.7;Invalid calendar user';
const bad = (condition = 'valid-scheduling-message') => davError(403, el(c(condition)));

function utcValue(prop) {
  const f = prop && parseDateFields(prop.value.trim());
  if (!f || !f.utc) throw bad();
  return fieldsToUtc(f, null);
}

/** Handles a POST to the outbox and returns the schedule-response element. */
export async function outboxPost(ctx, text) {
  const root = tryParse(text);
  const method = root && getProp(root, 'METHOD')?.value.trim().toUpperCase();
  const comp = root?.name === 'VCALENDAR' && root.comps.find((x) => x.name !== 'VTIMEZONE');
  if (!method || !comp) throw bad();
  const me = addressesOf(ctx, ctx.user);
  const organizer = getProp(comp, 'ORGANIZER');
  const results = [];

  if (comp.name === 'VFREEBUSY') {
    if (method !== 'REQUEST') throw bad();
    if (!organizer) throw bad('valid-organizer');
    if (!me.has(normalize(organizer.value))) throw bad('organizer-allowed');
    const start = utcValue(getProp(comp, 'DTSTART'));
    const end = utcValue(getProp(comp, 'DTEND'));
    const attendees = getProps(comp, 'ATTENDEE');
    if (end <= start || !attendees.length || attendees.length > MAX_RECIPIENTS) throw bad();
    for (const att of attendees) {
      const user = await findUser(ctx, att.value);
      if (!user) { results.push({ recipient: att.value, status: INVALID_USER }); continue; }
      const periods = await freeBusyOf(ctx, user, start, end);
      const data = buildFreeBusy({ uid: getProp(comp, 'UID')?.value, start, end, periods, organizer: organizer.value, attendee: att.value, method: 'REPLY' });
      results.push({ recipient: att.value, status: SUCCESS, data });
    }
  } else if (comp.name === 'VEVENT') {
    let recipients;
    if (method === 'REQUEST' || method === 'CANCEL') {
      if (!organizer) throw bad('valid-organizer');
      if (!me.has(normalize(organizer.value))) throw bad('organizer-allowed');
      recipients = getProps(comp, 'ATTENDEE').filter((p) => !me.has(normalize(p.value))).map((p) => p.value);
    } else if (method === 'REPLY') {
      const attendees = getProps(comp, 'ATTENDEE');
      if (!organizer || attendees.length !== 1) throw bad();
      if (!me.has(normalize(attendees[0].value))) throw bad('attendee-allowed');
      recipients = [organizer.value];
    } else {
      throw bad();
    }
    if (!recipients.length || recipients.length > MAX_RECIPIENTS) throw bad();
    for (const address of recipients) {
      const user = await findUser(ctx, address);
      if (!user) { results.push({ recipient: address, status: INVALID_USER }); continue; }
      try {
        await deliver(ctx, user, serializeComponent(root));
        results.push({ recipient: address, status: SUCCESS });
      } catch (err) {
        console.error('scheduling delivery failed:', err);
        results.push({ recipient: address, status: '5.1;Service unavailable' });
      }
    }
  } else {
    throw bad();
  }

  return el(c('schedule-response'), null, results.map((r) => el(
    c('response'), null,
    el(c('recipient'), null, el(d('href'), null, r.recipient)),
    el(c('request-status'), null, r.status),
    r.data ? el(c('calendar-data'), null, r.data) : null,
  )));
}
