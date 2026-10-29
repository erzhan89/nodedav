// Recurrence instances of VEVENT groups (a master plus its RECURRENCE-ID overrides) within a time range.
import { getProp } from './ical.js';
import { eventRange, isRecurring, recurrenceIdMs } from './calendar.js';
import { expandStarts } from './recurrence.js';
import { DAY } from './dates.js';

const MAX_LOOKAHEAD = 50 * 365 * DAY;

/**
 * comps: VEVENTs sharing one UID. Returns [{ comp, start, end, recurrenceId (ms|null), allDay }] overlapping [rs, re).
 * Overrides replace the generated instance they name; a recurrence rule too exotic to expand yields only its first start.
 */
export function instancesIn(comps, rs, re) {
  const out = [];
  const hit = (s, dur) => (dur > 0 ? s < re && s + dur > rs : rs <= s && re > s);
  const overridden = new Set(comps.filter((x) => getProp(x, 'RECURRENCE-ID')).map(recurrenceIdMs).filter((v) => v !== undefined));

  for (const comp of comps) {
    const range = eventRange(comp);
    if (!range) continue;
    const dur = range.end - range.start;
    if (getProp(comp, 'RECURRENCE-ID')) {
      if (hit(range.start, dur)) out.push({ comp, start: range.start, end: range.end, recurrenceId: recurrenceIdMs(comp) ?? null, allDay: range.allDay });
    } else if (!isRecurring(comp)) {
      if (hit(range.start, dur)) out.push({ comp, start: range.start, end: range.end, recurrenceId: null, allDay: range.allDay });
    } else {
      const anchor = Number.isFinite(rs) ? Math.max(rs, range.start) : range.start;
      const { starts, status } = expandStarts(comp, Math.min(re, anchor + MAX_LOOKAHEAD));
      const list = status === 'unsupported' || status === 'unbounded' ? [range.start] : starts;
      for (const s of list) {
        if (!overridden.has(s) && hit(s, dur)) out.push({ comp, start: s, end: s + dur, recurrenceId: s, allDay: range.allDay });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
