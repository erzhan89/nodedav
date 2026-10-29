export const DAY = 86_400_000;

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

export function parseDateFields(value) {
  const m = DT_RE.exec(String(value).trim());
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0),
    allDay: m[4] === undefined,
    utc: m[7] === 'Z',
  };
}

const formatters = new Map();
function formatterFor(tz) {
  if (formatters.has(tz)) return formatters.get(tz);
  let fmt = null;
  const candidates = [tz, /([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_\-0-9]+)?)$/.exec(tz)?.[1]];
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: cand, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      break;
    } catch { /* unknown zone name, try next candidate */ }
  }
  if (formatters.size < 256) formatters.set(tz, fmt);
  return fmt;
}

/** Offset (ms) of `tz` from UTC at the given instant. Unknown zones are treated as UTC. */
export function tzOffsetMs(tz, utcMs) {
  const fmt = formatterFor(tz);
  if (!fmt) return 0;
  const p = {};
  for (const part of fmt.formatToParts(utcMs)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function zonedToUtc(f, tz) {
  const guess = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  const off1 = tzOffsetMs(tz, guess);
  const t = guess - off1;
  const off2 = tzOffsetMs(tz, t);
  return off2 === off1 ? t : guess - off2;
}

/** Convert parsed fields to a UTC timestamp. Floating and all-day values are treated as UTC. */
export function fieldsToUtc(f, tz) {
  if (f.allDay || f.utc || !tz) return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  return zonedToUtc(f, tz);
}

export function parseDateValue(value, params) {
  const f = parseDateFields(value);
  if (!f) return null;
  const tz = params?.TZID?.[0] ?? null;
  return { ms: fieldsToUtc(f, tz), allDay: f.allDay, fields: f, tz };
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDuration(value) {
  const m = DURATION_RE.exec(String(value).trim());
  if (!m) return null;
  const [, sign, w, dd, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(dd ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}
