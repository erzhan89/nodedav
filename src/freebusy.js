// Free/busy computation (RFC 4791 7.10, RFC 6638 5) and VFREEBUSY output.
import { getProp, parseComponent } from './ical.js';
import { instancesIn } from './instances.js';

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/** Busy periods [{start, end, type}] (ms) from parsed VCALENDAR trees, clipped to [rs, re) and merged per type. */
export function busyPeriods(roots, rs, re) {
  const byType = { BUSY: [], 'BUSY-TENTATIVE': [] };
  for (const root of roots) {
    const groups = new Map();
    for (const comp of root.comps) {
      if (comp.name !== 'VEVENT') continue;
      const uid = getProp(comp, 'UID')?.value ?? '';
      (groups.get(uid) ?? groups.set(uid, []).get(uid)).push(comp);
    }
    for (const comps of groups.values()) {
      for (const inst of instancesIn(comps, rs, re)) {
        const status = getProp(inst.comp, 'STATUS')?.value.trim().toUpperCase();
        if (status === 'CANCELLED') continue;
        if (getProp(inst.comp, 'TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT') continue;
        const start = Math.max(inst.start, rs);
        const end = Math.min(inst.end, re);
        if (end > start) byType[status === 'TENTATIVE' ? 'BUSY-TENTATIVE' : 'BUSY'].push({ start, end });
      }
    }
  }
  const out = [];
  for (const [type, list] of Object.entries(byType)) {
    list.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const p of list) {
      if (cur && p.start <= cur.end) cur.end = Math.max(cur.end, p.end);
      else { cur = { ...p, type }; out.push(cur); }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export const busyFromData = (dataList, rs, re) => {
  const roots = [];
  for (const data of dataList) {
    try { roots.push(parseComponent(data)); } catch { /* unparseable objects contribute nothing */ }
  }
  return busyPeriods(roots, rs, re);
};

/** A VCALENDAR holding one VFREEBUSY. `method` (REPLY / ...) is added when given. */
export function buildFreeBusy({ uid, start, end, periods, organizer = null, attendee = null, method = null }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//nodedav//EN'];
  if (method) lines.push(`METHOD:${method}`);
  lines.push('BEGIN:VFREEBUSY');
  if (uid) lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
  if (organizer) lines.push(`ORGANIZER:${organizer}`);
  if (attendee) lines.push(`ATTENDEE:${attendee}`);
  for (const type of ['BUSY', 'BUSY-TENTATIVE', 'BUSY-UNAVAILABLE']) {
    const list = periods.filter((p) => p.type === type);
    if (!list.length) continue;
    const value = list.map((p) => `${stamp(p.start)}/${stamp(p.end)}`).join(',');
    lines.push(type === 'BUSY' ? `FREEBUSY:${value}` : `FREEBUSY;FBTYPE=${type}:${value}`);
  }
  lines.push('END:VFREEBUSY', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
