import { ParseError, parseComponent, getProp, getProps } from './ical.js';
import { DAY, parseDateValue, parseDateFields, fieldsToUtc, parseDuration } from './dates.js';
import { expandStarts } from './recurrence.js';
import { instancesIn } from './instances.js';

const MAX_LOOKAHEAD = 50 * 365 * DAY;
const SCHEDULABLE = new Set(['VEVENT', 'VTODO', 'VJOURNAL']);

/** Validation failure carrying the CalDAV precondition element name to report. */
export class CalendarError extends Error {
  constructor(condition, message) {
    super(message);
    this.condition = condition;
  }
}

const dateProp = (comp, name) => {
  const p = getProp(comp, name);
  return p ? parseDateValue(p.value, p.params) : null;
};

export function eventRange(comp) {
  const start = dateProp(comp, 'DTSTART');
  if (!start) return null;
  const dtend = dateProp(comp, 'DTEND');
  const dur = getProp(comp, 'DURATION');
  let end;
  if (dtend) end = dtend.ms;
  else if (dur) end = start.ms + (parseDuration(dur.value) ?? 0);
  else end = start.allDay ? start.ms + DAY : start.ms;
  return { start: start.ms, end, allDay: start.allDay };
}

export const isRecurring = (comp) =>
  !getProp(comp, 'RECURRENCE-ID') && (getProp(comp, 'RRULE') || getProp(comp, 'RDATE'));

export function recurrenceIdMs(comp) {
  const p = getProp(comp, 'RECURRENCE-ID');
  return p ? parseDateValue(p.value, p.params)?.ms : undefined;
}

export function eventOverlaps(comp, siblings, rs, re) {
  const base = eventRange(comp);
  if (!base) return false;
  const dur = base.end - base.start;
  const hit = (s) => (dur > 0 ? s < re && s + dur > rs : rs <= s && re > s);
  if (!isRecurring(comp)) return hit(base.start);

  const overridden = new Set(siblings.filter((s) => s !== comp).map(recurrenceIdMs).filter((v) => v !== undefined));
  const anchor = Number.isFinite(rs) ? Math.max(rs, base.start) : base.start;
  const { starts, status } = expandStarts(comp, Math.min(re, anchor + MAX_LOOKAHEAD));
  if (status === 'unsupported' || status === 'capped') return base.start <= re;
  return starts.some((s) => !overridden.has(s) && hit(s));
}

export function todoOverlaps(comp, rs, re) {
  const ms = (name) => dateProp(comp, name)?.ms;
  const start = ms('DTSTART');
  const due = ms('DUE');
  const completed = ms('COMPLETED');
  const created = ms('CREATED');
  const durProp = getProp(comp, 'DURATION');
  const dur = durProp ? parseDuration(durProp.value) : null;

  if (start !== undefined && dur !== null) {
    const end = start + dur;
    return rs <= end && (re > start || re >= end);
  }
  if (start !== undefined && due !== undefined) return (rs < due || rs <= start) && (re > start || re >= due);
  if (start !== undefined) return rs <= start && re > start;
  if (due !== undefined) return rs < due && re >= due;
  if (completed !== undefined && created !== undefined) {
    return (rs <= created || rs <= completed) && (re >= created || re >= completed);
  }
  if (completed !== undefined) return rs <= completed && re >= completed;
  if (created !== undefined) return re > created;
  return true;
}

export function journalOverlaps(comp, rs, re) {
  const start = dateProp(comp, 'DTSTART');
  return start ? rs <= start.ms && re > start.ms : false;
}

/** RFC 4791 9.9: does any trigger of the alarm (including REPEAT) fall in [rs, re)? */
export function alarmOverlaps(alarm, parent, parentSiblings, rs, re) {
  const trigger = getProp(alarm, 'TRIGGER');
  if (!trigger) return false;
  const repeat = Math.max(0, parseInt(getProp(alarm, 'REPEAT')?.value ?? '0', 10) || 0);
  const step = parseDuration(getProp(alarm, 'DURATION')?.value ?? '') ?? 0;
  const inRange = (t) => {
    for (let n = 0; n <= repeat; n++) if (t + n * step >= rs && t + n * step < re) return true;
    return false;
  };
  if (trigger.params.VALUE?.[0]?.toUpperCase() === 'DATE-TIME') {
    const abs = parseDateValue(trigger.value, {});
    return abs ? inRange(abs.ms) : false;
  }
  const offset = parseDuration(trigger.value);
  if (offset === null || !parent) return false;
  const fromEnd = trigger.params.RELATED?.[0]?.toUpperCase() === 'END';
  const anchors = [];
  if (parent.name === 'VEVENT') {
    const shift = Math.abs(offset) + repeat * Math.abs(step);
    for (const inst of instancesIn(parentSiblings ?? [parent], rs - shift - DAY, re + shift + DAY)) anchors.push(fromEnd ? inst.end : inst.start);
  } else {
    const ms = (name) => dateProp(parent, name)?.ms;
    const a = fromEnd ? ms('DUE') ?? ms('DTEND') : ms('DTSTART') ?? ms('DUE');
    if (a !== undefined) anchors.push(a);
  }
  return anchors.some((a) => inRange(a + offset));
}

/** Does the component (with its same-named siblings, for recurrence overrides) overlap [rs, re)? */
export function componentOverlaps(comp, siblings, rs, re, parent = null, parentSiblings = null) {
  switch (comp.name) {
    case 'VALARM': return alarmOverlaps(comp, parent, parentSiblings, rs, re);
    case 'VEVENT': return eventOverlaps(comp, siblings, rs, re);
    case 'VTODO': return todoOverlaps(comp, rs, re);
    case 'VJOURNAL': return journalOverlaps(comp, rs, re);
    default: return true;
  }
}

const boundMs = (value, fallback) => {
  const f = value ? parseDateFields(value) : null;
  return f ? fieldsToUtc(f, null) : fallback;
};

/** RFC 4791 5.2.6-5.2.9 limits advertised as min/max-date-time, max-instances, max-attendees-per-instance. */
function enforceLimits(comps, { minDateTime, maxDateTime, maxInstances = 0, maxAttendees = 0 }) {
  const min = boundMs(minDateTime, -Infinity);
  const max = boundMs(maxDateTime, Infinity);
  let instances = 0;
  for (const comp of comps) {
    if (maxAttendees && getProps(comp, 'ATTENDEE').length > maxAttendees) {
      throw new CalendarError('max-attendees-per-instance', 'too many attendees');
    }
    for (const name of ['DTSTART', 'DTEND', 'DUE']) {
      const when = dateProp(comp, name);
      if (!when) continue;
      if (when.ms < min) throw new CalendarError('min-date-time', `${name} is too early`);
      if (when.ms > max) throw new CalendarError('max-date-time', `${name} is too late`);
    }
    if (maxInstances) {
      if (!isRecurring(comp)) { instances += 1; continue; }
      const { starts, status } = expandStarts(comp, Infinity, maxInstances + 1);
      if (status === 'unbounded') throw new CalendarError('max-instances', 'unbounded recurrence');
      instances += starts.length;
    }
    if (maxInstances && instances > maxInstances) throw new CalendarError('max-instances', 'too many instances');
  }
}

/**
 * Validates a calendar object resource (RFC 4791 5.3.2.1) and extracts index data.
 * Throws CalendarError. Times are returned in whole seconds, or null when unknown / unbounded.
 */
export function analyzeCalendar(text, limits = {}) {
  let root;
  try {
    root = parseComponent(text);
  } catch (e) {
    if (e instanceof ParseError) throw new CalendarError('valid-calendar-data', e.message);
    throw e;
  }
  if (root.name !== 'VCALENDAR') throw new CalendarError('valid-calendar-data', 'not a VCALENDAR');
  if (getProp(root, 'METHOD')) throw new CalendarError('valid-calendar-object-resource', 'METHOD is not allowed in stored objects');

  const comps = root.comps.filter((c) => c.name !== 'VTIMEZONE');
  if (!comps.length) throw new CalendarError('valid-calendar-object-resource', 'no calendar component found');
  const componentType = comps[0].name;
  if (!SCHEDULABLE.has(componentType)) throw new CalendarError('valid-calendar-object-resource', `unsupported component ${componentType}`);
  const uid = getProp(comps[0], 'UID')?.value;
  if (!uid) throw new CalendarError('valid-calendar-object-resource', 'UID is required');
  for (const comp of comps) {
    if (comp.name !== componentType) throw new CalendarError('valid-calendar-object-resource', 'mixed component types');
    if (getProp(comp, 'UID')?.value !== uid) throw new CalendarError('valid-calendar-object-resource', 'mixed UIDs');
  }

  enforceLimits(comps, limits);

  let first = null;
  let last = null;
  if (componentType === 'VEVENT') {
    let lo = Infinity;
    let hi = -Infinity;
    let unbounded = false;
    for (const comp of comps) {
      const r = eventRange(comp);
      if (!r) continue;
      lo = Math.min(lo, r.start);
      if (isRecurring(comp)) {
        const { starts, status } = expandStarts(comp, Infinity);
        if (status !== 'ok') { unbounded = true; continue; }
        hi = Math.max(hi, starts.reduce((a, b) => Math.max(a, b), -Infinity) + (r.end - r.start));
      } else {
        hi = Math.max(hi, r.end);
      }
    }
    if (Number.isFinite(lo)) first = Math.floor(lo / 1000);
    if (!unbounded && Number.isFinite(hi)) last = Math.ceil(hi / 1000);
  }
  return { uid, componentType, firstOccurrence: first, lastOccurrence: last, root };
}
