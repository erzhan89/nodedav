// jCal (RFC 7265) and jCard (RFC 7095): lossless JSON views of iCalendar / vCard text.
import { parseComponent, serializeComponent } from './ical.js';

export const JCAL_TYPE = 'application/calendar+json';
export const JCARD_TYPE = 'application/vcard+json';

const CAL_TYPES = {
  CALSCALE: 'text', METHOD: 'text', PRODID: 'text', VERSION: 'text', ATTACH: 'uri', CATEGORIES: 'text', CLASS: 'text', COMMENT: 'text',
  DESCRIPTION: 'text', GEO: 'float', LOCATION: 'text', 'PERCENT-COMPLETE': 'integer', PRIORITY: 'integer', RESOURCES: 'text', STATUS: 'text',
  SUMMARY: 'text', COMPLETED: 'date-time', DTEND: 'date-time', DUE: 'date-time', DTSTART: 'date-time', DURATION: 'duration', FREEBUSY: 'period',
  TRANSP: 'text', TZID: 'text', TZNAME: 'text', TZOFFSETFROM: 'utc-offset', TZOFFSETTO: 'utc-offset', TZURL: 'uri', ATTENDEE: 'cal-address',
  CONTACT: 'text', ORGANIZER: 'cal-address', 'RECURRENCE-ID': 'date-time', 'RELATED-TO': 'text', URL: 'uri', UID: 'text', EXDATE: 'date-time',
  RDATE: 'date-time', RRULE: 'recur', ACTION: 'text', REPEAT: 'integer', TRIGGER: 'duration', CREATED: 'date-time', DTSTAMP: 'date-time',
  'LAST-MODIFIED': 'date-time', SEQUENCE: 'integer', 'REQUEST-STATUS': 'text',
};
const CARD_TYPES = {
  URL: 'uri', PHOTO: 'uri', LOGO: 'uri', SOUND: 'uri', KEY: 'uri', SOURCE: 'uri', IMPP: 'uri', MEMBER: 'uri', FBURL: 'uri', CALURI: 'uri', CALADRURI: 'uri',
  BDAY: 'date-and-or-time', ANNIVERSARY: 'date-and-or-time', REV: 'timestamp',
};
const MULTI = new Set(['CATEGORIES', 'RESOURCES', 'EXDATE', 'RDATE', 'FREEBUSY', 'NICKNAME']);
const STRUCTURED = new Set(['N', 'ADR', 'ORG', 'GENDER']);
const RECUR_NUMBERS = new Set(['COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS']);

export class JsonCalendarError extends Error {}
const fail = (m) => { throw new JsonCalendarError(m); };

// ---- text helpers --------------------------------------------------------------

function splitUnescaped(text, sep) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { cur += ch + text[++i]; continue; }
    if (ch === sep) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
const unescape = (v) => v.replace(/\\([nN,;\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
const escape = (v) => String(v).replace(/\r/g, '').replace(/[\;,]/g, '\\$&').replace(/\n/g, '\\n');

// ---- value conversion ---------------------------------------------------------------

const DT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const DT_JSON = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/;

function recurToJson(v) {
  const out = {};
  for (const part of v.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).toUpperCase();
    const raw = part.slice(eq + 1);
    let val;
    if (key === 'UNTIL') val = toJson(DT.test(raw) ? 'date-time' : 'date', raw);
    else if (RECUR_NUMBERS.has(key)) {
      const nums = raw.split(',').map((x) => (/^[+-]?\d+$/.test(x) ? Number(x) : x));
      val = nums.length === 1 ? nums[0] : nums;
    } else if (key === 'BYDAY' || key === 'BYEASTER') {
      const days = raw.split(',');
      val = days.length === 1 ? days[0] : days;
    } else val = raw;
    out[key.toLowerCase()] = val;
  }
  return out;
}

function recurFromJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('recur value must be an object');
  const keys = Object.keys(obj);
  keys.sort((a, b) => (a === 'freq' ? -1 : b === 'freq' ? 1 : 0));
  return keys.map((k) => {
    const raw = obj[k];
    const val = k === 'until' ? fromJson(DT_JSON.test(raw) ? 'date-time' : 'date', raw) : [].concat(raw).join(',');
    return `${k.toUpperCase()}=${val}`;
  }).join(';');
}

function toJson(type, v) {
  let m;
  switch (type) {
    case 'date': return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v;
    case 'date-time':
      return (m = DT.exec(v)) ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}` : v;
    case 'time': return (m = /^(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)) ? `${m[1]}:${m[2]}:${m[3]}${m[4]}` : v;
    case 'utc-offset': return (m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v)) ? `${m[1]}${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ''}` : v;
    case 'integer': case 'float': return Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : v;
    case 'boolean': return v.toUpperCase() === 'TRUE';
    case 'period': return v.split('/').map((p) => (/^[+-]?P/i.test(p) ? p : toJson('date-time', p))).join('/');
    case 'recur': return recurToJson(v);
    case 'date-and-or-time': return /^\d{8}$/.test(v) ? toJson('date', v) : (m = DT.exec(v)) ? toJson('date-time', v) : v;
    case 'timestamp': return toJson('date-time', v);
    case 'text': return unescape(v);
    default: return v;
  }
}

function fromJson(type, v, extended = false) {
  if (extended && ['date', 'date-time', 'timestamp', 'date-and-or-time'].includes(type) && typeof v === 'string') return v;
  switch (type) {
    case 'utc-offset': return String(v).replaceAll(':', '');
    case 'date': case 'time': case 'date-time': case 'timestamp': case 'date-and-or-time':
      return typeof v === 'string' ? v.replaceAll('-', '').replaceAll(':', '') : fail('date value must be a string');
    case 'period': return String(v).split('/').map((p) => (/^[+-]?P/i.test(p) ? p : fromJson('date-time', p))).join('/');
    case 'boolean': return v ? 'TRUE' : 'FALSE';
    case 'integer': case 'float': return String(v);
    case 'recur': return recurFromJson(v);
    case 'text': return escape(v);
    default: return String(v);
  }
}

// ---- properties -------------------------------------------------------------------

function propToJson(p, types) {
  const params = {};
  for (const [k, v] of Object.entries(p.params)) {
    if (k === 'VALUE') continue;
    params[k.toLowerCase()] = v.length === 1 ? v[0] : v;
  }
  if (p.group) params.group = p.group.toLowerCase();
  let type = p.params.VALUE?.[0]?.toLowerCase() ?? types[p.name] ?? 'text';
  if (p.params.ENCODING && p.name !== 'ATTACH') type = 'binary';
  const name = p.name.toLowerCase();
  if (p.name === 'GEO') return [name, params, 'float', p.value.split(';').map(Number)];
  if (p.name === 'REQUEST-STATUS') return [name, params, 'text', ...splitUnescaped(p.value, ';').map(unescape)];
  if (STRUCTURED.has(p.name) && types === CARD_TYPES) {
    const parts = splitUnescaped(p.value, ';').map((part) => {
      const items = splitUnescaped(part, ',').map(unescape);
      return items.length === 1 ? items[0] : items;
    });
    return [name, params, 'text', parts];
  }
  if (MULTI.has(p.name) || (type === 'period' && p.name === 'FREEBUSY')) {
    return [name, params, type, ...splitUnescaped(p.value, ',').map((x) => toJson(type, x))];
  }
  return [name, params, type, toJson(type, p.value)];
}

function propFromJson(entry, types, extended) {
  if (!Array.isArray(entry) || entry.length < 4 || typeof entry[0] !== 'string' || typeof entry[2] !== 'string') fail('malformed property');
  const [rawName, rawParams, type, ...values] = entry;
  const name = rawName.toUpperCase();
  const params = Object.create(null);
  let group = null;
  if (rawParams && typeof rawParams === 'object') {
    for (const [k, v] of Object.entries(rawParams)) {
      if (k === 'group') { group = String(v).toUpperCase(); continue; }
      params[k.toUpperCase()] = [].concat(v).map(String);
    }
  }
  const standard = types[name] ?? 'text';
  const lowerType = type.toLowerCase();
  if (lowerType !== standard && lowerType !== 'unknown' && lowerType !== 'binary') params.VALUE = [lowerType.toUpperCase()];
  let value;
  if (name === 'GEO') value = values[0].join(';');
  else if (name === 'REQUEST-STATUS') value = values.map(escape).join(';');
  else if (STRUCTURED.has(name) && types === CARD_TYPES) {
    value = values[0].map((part) => [].concat(part).map(escape).join(',')).join(';');
  } else {
    const kind = lowerType === 'binary' || lowerType === 'unknown' ? 'raw' : lowerType;
    value = values.map((v) => (kind === 'raw' ? String(v) : fromJson(kind, v, extended))).join(',');
  }
  return { name, params, value, group };
}

// ---- components ------------------------------------------------------------------

function compToJson(comp, types) {
  return [comp.name.toLowerCase(), comp.props.map((p) => propToJson(p, types)), comp.comps.map((c) => compToJson(c, types))];
}

function compFromJson(node, types, extended, depth = 0) {
  if (depth > 16 || !Array.isArray(node) || node.length !== 3 || typeof node[0] !== 'string' || !Array.isArray(node[1]) || !Array.isArray(node[2])) fail('malformed component');
  return { name: node[0].toUpperCase(), props: node[1].map((p) => propFromJson(p, types, extended)), comps: node[2].map((c) => compFromJson(c, types, extended, depth + 1)) };
}

const typesFor = (tree) => (tree.name === 'VCARD' ? CARD_TYPES : CAL_TYPES);

/** iCalendar / vCard text -> jCal / jCard JSON text. */
export function toJsonText(text) {
  const tree = parseComponent(text);
  return JSON.stringify(compToJson(tree, typesFor(tree)));
}

/** jCal / jCard JSON text -> iCalendar / vCard text. */
export function fromJsonText(text) {
  let node;
  try {
    node = JSON.parse(text);
  } catch {
    fail('not valid JSON');
  }
  const types = Array.isArray(node) && String(node[0]).toLowerCase() === 'vcard' ? CARD_TYPES : CAL_TYPES;
  const version = types === CARD_TYPES && node[1]?.find?.((p) => Array.isArray(p) && String(p[0]).toLowerCase() === 'version')?.[3];
  return serializeComponent(compFromJson(node, types, version === '3.0'));
}
