// Partial retrieval and expansion for calendar-data / address-data (RFC 4791 9.6, RFC 6352 10.4).
import { c, card } from './ns.js';
import { el, childOf, childrenOf } from './xml.js';
import { davError } from './errors.js';
import { parseComponent, serializeComponent, getProp } from './ical.js';
import { parseDateFields, fieldsToUtc } from './dates.js';
import { instancesIn } from './instances.js';
import { JCAL_TYPE, JCARD_TYPE, toJsonText } from './jcal.js';

const invalidCalendarData = () => davError(403, el(c('valid-calendar-data')));

function utcRange(node) {
  const parse = (v) => {
    const f = v && parseDateFields(v);
    if (!f || !f.utc) throw invalidCalendarData();
    return fieldsToUtc(f, null);
  };
  const start = parse(node.attrs.start);
  const end = parse(node.attrs.end);
  if (end <= start) throw invalidCalendarData();
  return { start, end };
}

/** Checks a request's calendar-data / address-data element up front so errors surface before any response is built. */
export function validateDataSpec(tag, node) {
  if (tag === c('calendar-data')) {
    const type = node.attrs['content-type'];
    if ((type && ![ 'text/calendar', JCAL_TYPE ].includes(type.toLowerCase())) || (node.attrs.version && node.attrs.version !== '2.0')) {
      throw davError(403, el(c('supported-calendar-data')));
    }
    for (const name of ['expand', 'limit-recurrence-set', 'limit-freebusy-set']) {
      const n = childOf(node, c(name));
      if (n) utcRange(n);
    }
    const top = childOf(node, c('comp'));
    if (top && top.attrs.name?.toUpperCase() !== 'VCALENDAR') throw invalidCalendarData();
  } else {
    const type = node.attrs['content-type'];
    if ((type && ![ 'text/vcard', JCARD_TYPE ].includes(type.toLowerCase())) || (node.attrs.version && !['3.0', '4.0'].includes(node.attrs.version))) {
      throw davError(403, el(card('supported-address-data-conversion')));
    }
  }
}

// ---- field selection -----------------------------------------------------------

function selectProps(comp, spec, ns) {
  if (childOf(spec, ns('allprop'))) return comp.props;
  const wanted = new Map(childrenOf(spec, ns('prop')).map((p) => [p.attrs.name?.toUpperCase(), p.attrs.novalue === 'yes']));
  return comp.props.filter((p) => wanted.has(p.name)).map((p) => (wanted.get(p.name) ? { ...p, value: '' } : p));
}

function selectComp(comp, spec) {
  const out = { name: comp.name, props: selectProps(comp, spec, c), comps: [] };
  if (childOf(spec, c('allcomp'))) {
    out.comps = comp.comps;
  } else {
    for (const sub of childrenOf(spec, c('comp'))) {
      const name = sub.attrs.name?.toUpperCase();
      for (const child of comp.comps) if (child.name === name) out.comps.push(selectComp(child, sub));
    }
  }
  return out;
}

// ---- expand / limit-recurrence-set --------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
function formatDate(ms, allDay) {
  const dt = new Date(ms);
  const day = `${pad(dt.getUTCFullYear(), 4)}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
  return allDay ? day : `${day}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

const dateProp = (name, ms, allDay) => ({ name, params: allDay ? { VALUE: ['DATE'] } : Object.create(null), value: formatDate(ms, allDay), group: null });
const RECURRENCE_PROPS = new Set(['RRULE', 'RDATE', 'EXRULE', 'EXDATE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID']);

function instanceComponent(inst, recurring) {
  const src = inst.comp;
  const hasEnd = Boolean(getProp(src, 'DTEND') || getProp(src, 'DURATION'));
  const props = src.props.filter((p) => !RECURRENCE_PROPS.has(p.name));
  props.push(dateProp('DTSTART', inst.start, inst.allDay));
  if (hasEnd) props.push(dateProp('DTEND', inst.end, inst.allDay));
  if (recurring || inst.recurrenceId != null) props.push(dateProp('RECURRENCE-ID', inst.recurrenceId ?? inst.start, inst.allDay));
  return { name: src.name, props, comps: src.comps };
}

const groupEvents = (root) => {
  const groups = new Map();
  for (const comp of root.comps) {
    if (comp.name !== 'VEVENT') continue;
    const uid = getProp(comp, 'UID')?.value ?? '';
    (groups.get(uid) ?? groups.set(uid, []).get(uid)).push(comp);
  }
  return groups;
};

function expandCalendar(root, { start, end }) {
  const out = { ...root, comps: [] };
  for (const comps of groupEvents(root).values()) {
    const recurring = comps.length > 1 || comps.some((x) => getProp(x, 'RRULE') || getProp(x, 'RDATE') || getProp(x, 'RECURRENCE-ID'));
    for (const inst of instancesIn(comps, start, end)) out.comps.push(instanceComponent(inst, recurring));
  }
  for (const comp of root.comps) if (comp.name !== 'VEVENT' && comp.name !== 'VTIMEZONE') out.comps.push(comp);
  return out;
}

function limitRecurrence(root, { start, end }) {
  const keep = new Set();
  for (const comps of groupEvents(root).values()) {
    for (const inst of instancesIn(comps, start, end)) if (inst.comp.props.some((p) => p.name === 'RECURRENCE-ID')) keep.add(inst.comp);
  }
  return { ...root, comps: root.comps.filter((x) => x.name !== 'VEVENT' || !getProp(x, 'RECURRENCE-ID') || keep.has(x)) };
}

// ---- entry points ---------------------------------------------------------------

/** Renders stored iCalendar text according to a calendar-data element (empty element = whole object). */
export function renderCalendarData(spec, data) {
  const text = renderCalendarText(spec, data);
  return spec.attrs['content-type']?.toLowerCase() === JCAL_TYPE ? safeJson(text) : text;
}

function safeJson(text) {
  try {
    return toJsonText(text);
  } catch {
    return text;
  }
}

function renderCalendarText(spec, data) {
  const expand = childOf(spec, c('expand'));
  const limit = childOf(spec, c('limit-recurrence-set'));
  const top = childOf(spec, c('comp'));
  if (!expand && !limit && !top) return data;
  let tree;
  try {
    tree = parseComponent(data);
  } catch {
    return data;
  }
  if (expand) tree = expandCalendar(tree, utcRange(expand));
  else if (limit) tree = limitRecurrence(tree, utcRange(limit));
  if (top) tree = selectComp(tree, top);
  return serializeComponent(tree);
}

/** Renders a stored vCard according to an address-data element: only the named properties (VERSION is always kept). */
export function renderAddressData(spec, data) {
  const text = renderAddressText(spec, data);
  return spec.attrs['content-type']?.toLowerCase() === JCARD_TYPE ? safeJson(text) : text;
}

function renderAddressText(spec, data) {
  const props = childrenOf(spec, card('prop'));
  if (!props.length || childOf(spec, card('allprop'))) return data;
  let tree;
  try {
    tree = parseComponent(data);
  } catch {
    return data;
  }
  const wanted = new Map(props.map((p) => [p.attrs.name?.toUpperCase(), p.attrs.novalue === 'yes']));
  wanted.set('VERSION', false);
  tree = { ...tree, props: tree.props.filter((p) => wanted.has(p.name)).map((p) => (wanted.get(p.name) ? { ...p, value: '' } : p)) };
  return serializeComponent(tree);
}

const knownZone = (tzid) => {
  try {
    return Boolean(tzid) && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(tzid) && Boolean(new Intl.DateTimeFormat('en', { timeZone: tzid }));
  } catch {
    return false;
  }
};

/** RFC 7809: with `CalDAV-Timezones: F` the client wants VTIMEZONEs it can resolve from the tz database left out. */
export function stripKnownTimezones(data) {
  let tree;
  try {
    tree = parseComponent(data);
  } catch {
    return data;
  }
  const kept = tree.comps.filter((x) => x.name !== 'VTIMEZONE' || !knownZone(getProp(x, 'TZID')?.value.trim()));
  return kept.length === tree.comps.length ? data : serializeComponent({ ...tree, comps: kept });
}

export const wantsNoTimezones = (headers) => String(headers['caldav-timezones'] ?? '').trim().toUpperCase() === 'F';
