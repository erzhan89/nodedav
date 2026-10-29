import { getProp, getProps } from './ical.js';
import { DAY, parseDateFields, fieldsToUtc } from './dates.js';

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const UNSUPPORTED_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYWEEKNO', 'BYYEARDAY'];
const ints = (v) => (v ? v.split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite) : []);

function parseRRule(value) {
  const parts = {};
  for (const kv of value.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
  }
  const freq = parts.FREQ?.toUpperCase();
  if (!FREQS.has(freq) || UNSUPPORTED_PARTS.some((k) => k in parts)) return null;

  let until = null;
  if (parts.UNTIL) {
    const f = parseDateFields(parts.UNTIL);
    if (!f) return null;
    until = fieldsToUtc(f, null) + (f.allDay ? DAY - 1 : 0);
  }
  const byday = (parts.BYDAY?.split(',') ?? [])
    .map((s) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim()))
    .filter(Boolean)
    .map((m) => ({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2].toUpperCase()] }));
  const rule = {
    freq,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1),
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    until,
    byday,
    bymonthday: ints(parts.BYMONTHDAY),
    bymonth: ints(parts.BYMONTH),
    bysetpos: ints(parts.BYSETPOS),
    wkst: WEEKDAYS[parts.WKST?.toUpperCase()] ?? 1,
  };
  if (rule.freq === 'YEARLY' && rule.byday.length && !rule.bymonth.length) return null;
  return rule;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayIndex = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const ymdFromIndex = (i) => {
  const dt = new Date(i * DAY);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
};
const normalizeMonthDays = (list, dim) => new Set(list.map((n) => (n < 0 ? dim + 1 + n : n)).filter((n) => n >= 1 && n <= dim));

function monthDays(y, m, rule, defaultDay) {
  const dim = daysInMonth(y, m);
  let days;
  if (rule.byday.length) {
    days = new Set();
    const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    for (const { n, wd } of rule.byday) {
      const all = [];
      for (let dd = 1 + ((wd - firstWd + 7) % 7); dd <= dim; dd += 7) all.push(dd);
      if (!n) all.forEach((x) => days.add(x));
      else {
        const x = n > 0 ? all[n - 1] : all[all.length + n];
        if (x) days.add(x);
      }
    }
    if (rule.bymonthday.length) {
      const allowed = normalizeMonthDays(rule.bymonthday, dim);
      days = new Set([...days].filter((x) => allowed.has(x)));
    }
  } else if (rule.bymonthday.length) {
    days = normalizeMonthDays(rule.bymonthday, dim);
  } else {
    days = new Set(defaultDay <= dim ? [defaultDay] : []);
  }
  return [...days].sort((a, b) => a - b).map((dd) => [y, m, dd]);
}

function periodCandidates(rule, f0, p) {
  const { freq, interval } = rule;
  let cands;
  let lower;
  if (freq === 'DAILY') {
    const idx = dayIndex(f0.y, f0.mo, f0.d) + p * interval;
    lower = idx * DAY;
    cands = [ymdFromIndex(idx)];
    if (rule.byday.length) {
      const wds = new Set(rule.byday.map((b) => b.wd));
      cands = cands.filter(([y, m, dd]) => wds.has(new Date(Date.UTC(y, m - 1, dd)).getUTCDay()));
    }
    if (rule.bymonthday.length) {
      cands = cands.filter(([y, m, dd]) => normalizeMonthDays(rule.bymonthday, daysInMonth(y, m)).has(dd));
    }
  } else if (freq === 'WEEKLY') {
    const dow0 = new Date(Date.UTC(f0.y, f0.mo - 1, f0.d)).getUTCDay();
    const weekStart = dayIndex(f0.y, f0.mo, f0.d) - ((dow0 - rule.wkst + 7) % 7) + 7 * interval * p;
    lower = weekStart * DAY;
    const wds = rule.byday.length ? [...new Set(rule.byday.map((b) => b.wd))] : [dow0];
    cands = wds.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)).sort((a, b) => a - b).map(ymdFromIndex);
  } else if (freq === 'MONTHLY') {
    const total = f0.y * 12 + (f0.mo - 1) + p * interval;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    lower = Date.UTC(y, m - 1, 1);
    cands = monthDays(y, m, rule, f0.d);
  } else {
    const y = f0.y + p * interval;
    lower = Date.UTC(y, 0, 1);
    const months = rule.bymonth.length
      ? rule.bymonth
      : rule.bymonthday.length ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [f0.mo];
    cands = [...months].sort((a, b) => a - b).flatMap((m) => monthDays(y, m, rule, f0.d));
  }
  if (freq !== 'YEARLY' && rule.bymonth.length) cands = cands.filter(([, m]) => rule.bymonth.includes(m));
  if (rule.bysetpos.length) {
    const picked = rule.bysetpos
      .map((i) => (i > 0 ? cands[i - 1] : cands[cands.length + i]))
      .filter(Boolean);
    cands = [...new Set(picked)].sort((a, b) => dayIndex(...a) - dayIndex(...b));
  }
  return { cands, lower };
}

function generate(rule, f0, tz, bound, cap) {
  const limit = Math.min(bound, rule.until ?? Infinity);
  if (limit === Infinity && rule.count == null) return { starts: [], status: 'unbounded' };
  const startMs = fieldsToUtc(f0, tz);
  const out = [];
  for (let p = 0; p < 200_000; p++) {
    const { cands, lower } = periodCandidates(rule, f0, p);
    if (lower - 2 * DAY > limit) break;
    for (const [y, m, dd] of cands) {
      const ms = fieldsToUtc({ ...f0, y, mo: m, d: dd }, tz);
      if (ms < startMs) continue;
      if (ms > limit) return { starts: out, status: 'ok' };
      out.push(ms);
      if (rule.count != null && out.length >= rule.count) return { starts: out, status: 'ok' };
      if (out.length >= cap) return { starts: out, status: 'capped' };
    }
  }
  return { starts: out, status: 'ok' };
}

/**
 * Expands the start instants of a recurring component up to `bound` (UTC ms, may be Infinity).
 * status: 'ok' | 'unsupported' (rule too exotic) | 'unbounded' (infinite rule, infinite bound) | 'capped'.
 * Callers must treat anything other than 'ok' conservatively.
 */
export function expandStarts(comp, bound, cap = 50_000) {
  const dtstart = getProp(comp, 'DTSTART');
  const f0 = dtstart && parseDateFields(dtstart.value);
  if (!f0) return { starts: [], status: 'unsupported' };
  const tz = dtstart.params.TZID?.[0] ?? null;
  const starts = new Set([fieldsToUtc(f0, tz)]);
  let status = 'ok';

  const rrule = getProp(comp, 'RRULE');
  if (rrule) {
    const rule = parseRRule(rrule.value);
    if (!rule) status = 'unsupported';
    else {
      const r = generate(rule, f0, tz, bound, cap);
      status = r.status;
      r.starts.forEach((s) => starts.add(s));
    }
  }
  const instants = (prop) =>
    prop.value.split(',').flatMap((v) => {
      const f = parseDateFields(v.split('/')[0]);
      return f ? [fieldsToUtc(f, prop.params.TZID?.[0] ?? tz)] : [];
    });
  for (const p of getProps(comp, 'RDATE')) for (const ms of instants(p)) if (ms <= bound) starts.add(ms);
  for (const p of getProps(comp, 'EXDATE')) for (const ms of instants(p)) starts.delete(ms);
  return { starts: [...starts].sort((a, b) => a - b), status };
}
