// RFC 7953 VAVAILABILITY: working hours that turn into BUSY-UNAVAILABLE free-busy time.
import { parseComponent, getProp } from './ical.js';
import { eventRange } from './calendar.js';
import { instancesIn } from './instances.js';

/** Throws unless text is a VCALENDAR holding exactly one VAVAILABILITY (RFC 7953 6.1). */
export function assertAvailability(text) {
  const root = parseComponent(text);
  if (root.name !== 'VCALENDAR') throw new Error('not a VCALENDAR');
  const vavs = root.comps.filter((x) => x.name === 'VAVAILABILITY');
  if (vavs.length !== 1 || root.comps.some((x) => x.name !== 'VAVAILABILITY' && x.name !== 'VTIMEZONE')) throw new Error('exactly one VAVAILABILITY expected');
  return root;
}

const merge = (list) => {
  const out = [];
  for (const p of [...list].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else out.push({ ...p });
  }
  return out;
};

const subtract = (from, cut) => {
  let pieces = from.map((p) => ({ ...p }));
  for (const c of merge(cut)) {
    pieces = pieces.flatMap((p) => {
      if (c.end <= p.start || c.start >= p.end) return [p];
      const rest = [];
      if (c.start > p.start) rest.push({ ...p, end: c.start });
      if (c.end < p.end) rest.push({ ...p, start: c.end });
      return rest;
    });
  }
  return pieces;
};

const priorityOf = (vav) => {
  const n = parseInt(getProp(vav, 'PRIORITY')?.value, 10);
  return n >= 1 && n <= 9 ? n : 10;
};

/** BUSY-UNAVAILABLE (or the declared BUSYTYPE) periods within [rs, re) where the VAVAILABILITY says nobody is available. */
export function unavailablePeriods(text, rs, re) {
  let root;
  try {
    root = assertAvailability(text);
  } catch {
    return [];
  }
  const vavs = root.comps.filter((x) => x.name === 'VAVAILABILITY').sort((a, b) => priorityOf(a) - priorityOf(b));
  let unclaimed = [{ start: rs, end: re }];
  const out = [];
  for (const vav of vavs) {
    const own = getProp(vav, 'DTSTART') ? eventRange(vav) : null;
    const bounds = { start: own ? Math.max(own.start, rs) : rs, end: own && getProp(vav, 'DTEND') ? Math.min(own.end, re) : re };
    if (bounds.end <= bounds.start) continue;
    const claimed = subtract([bounds], subtract([bounds], unclaimed));
    if (!claimed.length) continue;
    const available = vav.comps.filter((x) => x.name === 'AVAILABLE')
      .flatMap((a) => instancesIn([a], bounds.start, bounds.end).map((i) => ({ start: i.start, end: i.end })));
    const type = getProp(vav, 'BUSYTYPE')?.value.trim().toUpperCase() ?? 'BUSY-UNAVAILABLE';
    for (const p of subtract(claimed, available)) out.push({ ...p, type });
    unclaimed = subtract(unclaimed, claimed);
  }
  return out.sort((x, y) => x.start - y.start);
}
