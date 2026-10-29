import { c, card } from './ns.js';
import { el, childOf, childrenOf } from './xml.js';
import { davError } from './errors.js';
import { unescapeText } from './ical.js';
import { parseDateValue } from './dates.js';
import { folder } from './collation.js';
import { componentOverlaps } from './calendar.js';

const invalidFilter = (ns) => davError(403, el(ns('valid-filter')));

export function parseTimeRange(node) {
  const conv = (v) => {
    if (v == null) return null;
    const p = parseDateValue(v, {});
    if (!p) throw invalidFilter(c);
    return p.ms;
  };
  return { start: conv(node.attrs.start) ?? -Infinity, end: conv(node.attrs.end) ?? Infinity };
}

function textMatches(raw, tm, ns) {
  const fold = folder(tm.attrs.collation);
  if (!fold) throw davError(403, el(ns('supported-collation')));
  const matchType = tm.attrs['match-type'] ?? 'contains';
  const hay = fold(unescapeText(raw));
  const needle = fold(tm.text);
  let ok;
  switch (matchType) {
    case 'equals': ok = hay === needle; break;
    case 'starts-with': ok = hay.startsWith(needle); break;
    case 'ends-with': ok = hay.endsWith(needle); break;
    default: ok = hay.includes(needle);
  }
  return tm.attrs['negate-condition'] === 'yes' ? !ok : ok;
}

function paramFilterMatches(prop, pf, ns) {
  const values = prop.params[pf.attrs.name?.toUpperCase()];
  if (childOf(pf, ns('is-not-defined'))) return !values;
  if (!values) return false;
  const tm = childOf(pf, ns('text-match'));
  return tm ? values.some((v) => textMatches(v, tm, ns)) : true;
}

/** combine: (boolean[]) => boolean, i.e. allOf / anyOf semantics for the checks on one property. */
function propFilterMatches(comp, pf, ns, combine) {
  const name = pf.attrs.name?.toUpperCase();
  if (!name) throw invalidFilter(ns);
  const props = comp.props.filter((p) => p.name === name);
  if (childOf(pf, ns('is-not-defined'))) return props.length === 0;
  if (!props.length) return false;

  const tms = childrenOf(pf, ns('text-match'));
  const pfs = childrenOf(pf, ns('param-filter'));
  const trs = childrenOf(pf, ns('time-range'));
  if (!tms.length && !pfs.length && !trs.length) return true;

  return props.some((p) => {
    const checks = [
      ...tms.map((tm) => textMatches(p.value, tm, ns)),
      ...pfs.map((f) => paramFilterMatches(p, f, ns)),
      ...trs.map((tr) => {
        const range = parseTimeRange(tr);
        const when = parseDateValue(p.value.split('/')[0], p.params);
        return when ? when.ms >= range.start && when.ms < range.end : false;
      }),
    ];
    return combine(checks);
  });
}

const allOf = (checks) => checks.every(Boolean);
const anyOf = (checks) => checks.some(Boolean);

function matchComponent(comp, filter, siblings, parent = null, parentSiblings = null) {
  const tr = childOf(filter, c('time-range'));
  if (tr) {
    const { start, end } = parseTimeRange(tr);
    if (!componentOverlaps(comp, siblings, start, end, parent, parentSiblings)) return false;
  }
  for (const pf of childrenOf(filter, c('prop-filter'))) {
    if (!propFilterMatches(comp, pf, c, allOf)) return false;
  }
  for (const cf of childrenOf(filter, c('comp-filter'))) {
    const subs = comp.comps.filter((s) => s.name === cf.attrs.name?.toUpperCase());
    if (childOf(cf, c('is-not-defined'))) {
      if (subs.length) return false;
    } else if (!subs.some((s) => matchComponent(s, cf, subs, comp, siblings))) {
      return false;
    }
  }
  return true;
}

/** Evaluates a CALDAV:filter element against a parsed VCALENDAR tree. */
export function matchCalendarFilter(filter, root) {
  const top = childOf(filter, c('comp-filter'));
  if (!top || top.attrs.name?.toUpperCase() !== 'VCALENDAR') throw invalidFilter(c);
  return matchComponent(root, top, [root]);
}

/** Evaluates a CARDDAV:filter element against a parsed VCARD. */
export function matchCardFilter(filter, vcard) {
  const pfs = childrenOf(filter, card('prop-filter'));
  if (!pfs.length) return true;
  const outer = filter.attrs.test === 'allof' ? allOf : anyOf;
  return outer(
    pfs.map((pf) => propFilterMatches(vcard, pf, card, pf.attrs.test === 'allof' ? allOf : anyOf)),
  );
}

/**
 * Derives what the store can pre-filter in SQL from a calendar-query filter:
 * the component type and an overall time range of the single inner comp-filter.
 */
export function calendarPrefilter(filter) {
  const top = childOf(filter, c('comp-filter'));
  const inner = top ? childrenOf(top, c('comp-filter')) : [];
  const result = { componentType: null, rangeStart: null, rangeEnd: null, trivial: false };
  if (inner.length !== 1 || childOf(inner[0], c('is-not-defined'))) return result;
  const f = inner[0];
  const type = f.attrs.name?.toUpperCase();
  // component_type only indexes the schedulable component; anything else must be evaluated on the parsed tree.
  if (!['VEVENT', 'VTODO', 'VJOURNAL'].includes(type)) return result;
  result.componentType = type;
  const tr = childOf(f, c('time-range'));
  if (tr) {
    const { start, end } = parseTimeRange(tr);
    if (Number.isFinite(start)) result.rangeStart = start;
    if (Number.isFinite(end)) result.rangeEnd = end;
  }
  // Nothing beyond the component type is asked for: no need to parse stored objects.
  result.trivial = f.children.length === 0
    && !top.children.some((ch) => ch.tag === c('prop-filter') || ch.tag === c('time-range'));
  return result;
}

/** Rejects unknown collations / match types anywhere in a filter, before any object is evaluated. */
export function validateFilter(filter, ns) {
  const walk = (node) => {
    if (node.tag === ns('text-match')) {
      if (!folder(node.attrs.collation)) throw davError(403, el(ns('supported-collation')));
      const type = node.attrs['match-type'];
      if (type && !['equals', 'contains', 'starts-with', 'ends-with'].includes(type)) throw invalidFilter(ns);
    }
    node.children.forEach((ch) => { if (typeof ch !== 'string') walk(ch); });
  };
  walk(filter);
}
