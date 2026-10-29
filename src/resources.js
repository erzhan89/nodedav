import { d, c, card, cs, ic } from './ns.js';
import { el, thawNode } from './xml.js';
import { HttpError } from './errors.js';
import { lockDiscovery, SUPPORTED_LOCK } from './locks.js';
import { COLLATIONS } from './collation.js';
import { renderCalendarData, renderAddressData, stripKnownTimezones, wantsNoTimezones } from './projection.js';
import { INBOX, OUTBOX, ensureInbox } from './inbox.js';
import { SUPPORTED_PRIVILEGE_SET, ACL_RESTRICTIONS, aclFor } from './acl-model.js';

const SYNC_PREFIX = 'http://nodedav.invalid/ns/sync/';
export const syncTokenUri = (n) => `${SYNC_PREFIX}${n}`;
export function parseSyncToken(uri) {
  if (!uri.startsWith(SYNC_PREFIX)) return null;
  const rest = uri.slice(SYNC_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

const encodeSegment = (s) => encodeURIComponent(s).replace(/%40/g, '@');

export function hrefFor(base, segments, isCollection) {
  return `${base}/${segments.map(encodeSegment).join('/')}${isCollection && segments.length ? '/' : ''}`;
}

/** Strips the base path and decodes the remaining URL path into validated segments. */
export function parsePath(pathname, base) {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) throw new HttpError(404, 'Not Found');
  const parts = pathname.slice(base.length).split('/').slice(1);
  if (parts.at(-1) === '') parts.pop();
  return parts.map((raw) => {
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    if (seg === '' || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) throw new HttpError(400, 'Invalid path segment');
    return seg;
  });
}

const OBJECT_KINDS = new Set(['calobj', 'card']);
const make = (kind, segments, extra = {}) => ({
  kind, segments, isCollection: !OBJECT_KINDS.has(kind), exists: true, ...extra,
});

function requireOwner(ctx, username) {
  if (username.toLowerCase() !== ctx.user.username) throw new HttpError(403, 'Forbidden');
}

const HOME_ROOTS = { calendars: 'calendar', addressbooks: 'addressbook' };

/**
 * Maps URL segments to a resource descriptor, or null if the path is not part of the tree.
 * Missing collections / objects are returned with exists: false so write methods can create them.
 */
export async function resolve(ctx, segs) {
  const [first, owner, collUri, objUri] = segs;
  if (segs.length === 0) return make('root', []);

  if (first === 'principals') {
    if (segs.length === 1) return make('principals', segs);
    if (segs.length > 2) return null;
    requireOwner(ctx, owner);
    return make('principal', segs);
  }

  const type = HOME_ROOTS[first];
  if (!type) return null;
  const isCal = type === 'calendar';
  if (segs.length === 1) return make(isCal ? 'calroot' : 'abroot', segs);
  requireOwner(ctx, owner);
  if (segs.length === 2) return make(isCal ? 'calhome' : 'abhome', segs);
  if (segs.length > 4) return null;

  if (isCal && collUri === OUTBOX) return segs.length === 3 ? make('outbox', segs) : null;
  if (isCal && collUri === INBOX) {
    const inbox = await ensureInbox(ctx.store, ctx.user.id);
    if (segs.length === 3) return make('inbox', segs, { collection: inbox });
    const object = await ctx.store.getObject(inbox.id, objUri);
    return make('calobj', segs, { collection: inbox, object, exists: !!object });
  }

  const collection = await ctx.store.getCollection(ctx.user.id, type, collUri);
  if (segs.length === 3) return make(type, segs, { collection, exists: !!collection });
  const object = collection ? await ctx.store.getObject(collection.id, objUri) : null;
  return make(isCal ? 'calobj' : 'card', segs, { collection, object, exists: !!object });
}

export const principalResource = (username) => make('principal', ['principals', username]);
export const principalPath = (ctx, username = ctx.user.username) => hrefFor(ctx.base, ['principals', username], true);
export const hrefOf = (ctx, r) => hrefFor(ctx.base, r.segments, r.isCollection);

export function collectionResource(ctx, parent, collection) {
  return make(parent.kind === 'calhome' ? 'calendar' : 'addressbook', [...parent.segments, collection.uri], { collection });
}

export function objectResource(parent, row) {
  return make(parent.kind === 'calendar' || parent.kind === 'inbox' ? 'calobj' : 'card', [...parent.segments, row.uri], { collection: parent.collection, object: row });
}

export async function listChildren(ctx, r, { withData = false } = {}) {
  const { store, user } = ctx;
  switch (r.kind) {
    case 'root':
      return [make('principals', ['principals']), make('calroot', ['calendars']), make('abroot', ['addressbooks'])];
    case 'principals': return [make('principal', ['principals', user.username])];
    case 'calroot': return [make('calhome', ['calendars', user.username])];
    case 'abroot': return [make('abhome', ['addressbooks', user.username])];
    case 'calhome': {
      const calendars = (await store.listCollections(user.id, 'calendar')).filter((col) => col.uri !== INBOX);
      return [
        ...calendars.map((col) => collectionResource(ctx, r, col)),
        make('inbox', [...r.segments, INBOX], { collection: await ensureInbox(store, user.id) }),
        make('outbox', [...r.segments, OUTBOX]),
      ];
    }
    case 'abhome': return (await store.listCollections(user.id, 'addressbook')).map((col) => collectionResource(ctx, r, col));
    case 'calendar':
    case 'inbox':
    case 'addressbook':
      return (await store.listObjects(r.collection.id, { withData })).map((row) => objectResource(r, row));
    default: return [];
  }
}

// ---- properties ----------------------------------------------------------

const hrefEl = (h) => el(d('href'), null, h);
const isCollectionKind = (r) => r.kind === 'calendar' || r.kind === 'addressbook';
const isObject = (r) => OBJECT_KINDS.has(r.kind);
const PUBLIC_KINDS = new Set(['root', 'principals', 'calroot', 'abroot']);

const RESOURCE_TYPES = {
  root: [el(d('collection'))],
  principals: [el(d('collection'))],
  calroot: [el(d('collection'))],
  abroot: [el(d('collection'))],
  calhome: [el(d('collection'))],
  abhome: [el(d('collection'))],
  principal: [el(d('collection')), el(d('principal'))],
  calendar: [el(d('collection')), el(c('calendar'))],
  inbox: [el(d('collection')), el(c('schedule-inbox'))],
  outbox: [el(d('collection')), el(c('schedule-outbox'))],
  addressbook: [el(d('collection')), el(card('addressbook'))],
  calobj: [],
  card: [],
};

const reportSet = (...tags) =>
  tags.map((t) => el(d('supported-report'), null, el(d('report'), null, el(t))));

const privilegeSet = (...names) => names.map((n) => el(d('privilege'), null, el(d(n))));

const schedulePrivilege = (name) => el(d('privilege'), null, el(c(name)));

function privileges(r) {
  if (r.kind === 'inbox') return [...privilegeSet('read', 'write-properties', 'unbind', 'read-acl', 'read-current-user-privilege-set'), schedulePrivilege('schedule-deliver')];
  if (r.kind === 'outbox') return [...privilegeSet('read', 'read-acl', 'read-current-user-privilege-set'), schedulePrivilege('schedule-send')];
  if (PUBLIC_KINDS.has(r.kind) || r.kind === 'principal') return privilegeSet('read', 'read-acl', 'read-current-user-privilege-set');
  if (r.kind === 'calhome' || r.kind === 'abhome') return privilegeSet('read', 'bind', 'unbind', 'read-acl', 'read-current-user-privilege-set');
  if (isObject(r)) return privilegeSet('read', 'write', 'write-properties', 'write-content', 'read-acl', 'read-current-user-privilege-set');
  return privilegeSet('read', 'write', 'write-properties', 'write-content', 'bind', 'unbind', 'read-acl', 'read-current-user-privilege-set');
}

const dataType = (r) => (r.kind === 'calobj' ? `text/calendar; charset=utf-8; component=${r.object.component_type}` : 'text/vcard; charset=utf-8');

/** Property getters: (ctx, resource) => string | node[] | undefined (undefined = property not defined). */
export const PROPS = {
  [d('resourcetype')]: (x, r) => RESOURCE_TYPES[r.kind],
  [d('displayname')]: (x, r) => {
    if (r.kind === 'principal') return x.user.display_name;
    if (isCollectionKind(r)) return r.collection.displayname ?? undefined;
    return undefined;
  },
  [d('current-user-principal')]: (x) => [hrefEl(principalPath(x))],
  [d('principal-URL')]: (x, r) => (r.kind === 'principal' ? [hrefEl(principalPath(x))] : undefined),
  [d('principal-collection-set')]: (x, r) => (r.kind === 'root' || r.kind === 'principal' ? [hrefEl(hrefFor(x.base, ['principals'], true))] : undefined),
  [d('owner')]: (x, r) => (PUBLIC_KINDS.has(r.kind) ? undefined : [hrefEl(principalPath(x))]),
  [d('current-user-privilege-set')]: (x, r) => privileges(r),
  [d('supported-privilege-set')]: () => SUPPORTED_PRIVILEGE_SET,
  [d('acl')]: (x, r) => aclFor(privileges(r), principalPath(x), PUBLIC_KINDS.has(r.kind)),
  [d('acl-restrictions')]: () => ACL_RESTRICTIONS,
  [d('inherited-acl-set')]: () => [],
  [d('alternate-URI-set')]: (x, r) => (r.kind === 'principal' ? [] : undefined),
  [d('group-membership')]: (x, r) => (r.kind === 'principal' ? [] : undefined),
  [d('supported-report-set')]: (x, r) => {
    if (r.kind === 'inbox') return reportSet(d('sync-collection'), c('calendar-multiget'), c('calendar-query'));
    if (r.kind === 'calendar') return reportSet(d('sync-collection'), c('calendar-multiget'), c('calendar-query'), c('free-busy-query'));
    if (r.kind === 'addressbook') return reportSet(d('sync-collection'), card('addressbook-multiget'), card('addressbook-query'));
    return undefined;
  },
  [d('sync-token')]: (x, r) => (isCollectionKind(r) || r.kind === 'inbox' ? syncTokenUri(r.collection.sync_token) : undefined),
  [cs('getctag')]: (x, r) => (isCollectionKind(r) || r.kind === 'inbox' ? syncTokenUri(r.collection.sync_token) : undefined),

  [d('getetag')]: (x, r) => (isObject(r) ? `"${r.object.etag}"` : undefined),
  [d('getcontenttype')]: (x, r) => (isObject(r) ? dataType(r) : undefined),
  [d('getcontentlength')]: (x, r) => (isObject(r) ? String(r.object.size) : undefined),
  [d('getlastmodified')]: (x, r) => (isObject(r) ? new Date(r.object.last_modified * 1000).toUTCString() : undefined),

  [c('calendar-home-set')]: (x, r) => (r.kind === 'principal' ? [hrefEl(hrefFor(x.base, ['calendars', x.user.username], true))] : undefined),
  [card('addressbook-home-set')]: (x, r) => (r.kind === 'principal' ? [hrefEl(hrefFor(x.base, ['addressbooks', x.user.username], true))] : undefined),
  [c('calendar-user-address-set')]: (x, r) => {
    if (r.kind !== 'principal') return undefined;
    return [...(x.user.email ? [hrefEl(`mailto:${x.user.email}`)] : []), hrefEl(principalPath(x))];
  },
  [c('schedule-inbox-URL')]: (x, r) => (r.kind === 'principal' ? [hrefEl(hrefFor(x.base, ['calendars', x.user.username, INBOX], true))] : undefined),
  [c('schedule-outbox-URL')]: (x, r) => (r.kind === 'principal' ? [hrefEl(hrefFor(x.base, ['calendars', x.user.username, OUTBOX], true))] : undefined),
  [c('timezone-service-set')]: (x, r) => (r.kind === 'calhome' ? [] : undefined),
  [c('calendar-user-type')]: (x, r) => (r.kind === 'principal' ? 'INDIVIDUAL' : undefined),
  [c('schedule-default-calendar-URL')]: (x, r) => {
    if (r.kind !== 'inbox') return undefined;
    const json = x.deadProps?.get(deadKey(r))?.get(c('schedule-default-calendar-URL'));
    return json === undefined ? [hrefEl(hrefFor(x.base, ['calendars', x.user.username, 'default'], true))] : thawNode(json).children;
  },
  [c('calendar-description')]: (x, r) => (r.kind === 'calendar' ? r.collection.description ?? undefined : undefined),
  [c('calendar-timezone')]: (x, r) => (r.kind === 'calendar' ? r.collection.timezone ?? undefined : undefined),
  [c('supported-calendar-component-set')]: (x, r) =>
    r.kind === 'calendar' ? r.collection.components.split(',').map((name) => el(c('comp'), { name })) : undefined,
  [c('supported-calendar-data')]: (x, r) =>
    r.kind === 'calendar' ? [el(c('calendar-data'), { 'content-type': 'text/calendar', version: '2.0' }), el(c('calendar-data'), { 'content-type': 'application/calendar+json', version: '2.0' })] : undefined,
  [c('max-resource-size')]: (x, r) => (r.kind === 'calendar' ? String(x.config.maxResourceSize) : undefined),
  [c('min-date-time')]: (x, r) => (r.kind === 'calendar' ? x.config.minDateTime : undefined),
  [c('max-date-time')]: (x, r) => (r.kind === 'calendar' ? x.config.maxDateTime : undefined),
  [c('max-instances')]: (x, r) => (r.kind === 'calendar' && x.config.maxInstances ? String(x.config.maxInstances) : undefined),
  [c('max-attendees-per-instance')]: (x, r) => (r.kind === 'calendar' && x.config.maxAttendees ? String(x.config.maxAttendees) : undefined),
  [c('supported-collation-set')]: (x, r) => (r.kind === 'calendar' ? COLLATIONS.map((n) => el(c('supported-collation'), null, n)) : undefined),
  [card('supported-collation-set')]: (x, r) => (r.kind === 'addressbook' ? COLLATIONS.map((n) => el(card('supported-collation'), null, n)) : undefined),
  [ic('calendar-color')]: (x, r) => (r.kind === 'calendar' ? r.collection.color ?? undefined : undefined),
  [ic('calendar-order')]: (x, r) => (r.kind === 'calendar' && r.collection.sort_order != null ? String(r.collection.sort_order) : undefined),

  [card('addressbook-description')]: (x, r) => (r.kind === 'addressbook' ? r.collection.description ?? undefined : undefined),
  [card('supported-address-data')]: (x, r) =>
    r.kind === 'addressbook'
      ? [el(card('address-data-type'), { 'content-type': 'text/vcard', version: '3.0' }), el(card('address-data-type'), { 'content-type': 'text/vcard', version: '4.0' }), el(card('address-data-type'), { 'content-type': 'application/vcard+json', version: '4.0' })]
      : undefined,
  [card('max-resource-size')]: (x, r) => (r.kind === 'addressbook' ? String(x.config.maxResourceSize) : undefined),

  [d('supportedlock')]: (x, r) => (isLockable(r) ? SUPPORTED_LOCK : undefined),
  [d('lockdiscovery')]: (x, r) => (isLockable(r) ? lockDiscovery(x, r) : undefined),
  [d('add-member')]: (x, r) => (isCollectionKind(r) ? [hrefEl(hrefOf(x, r))] : undefined),

  // RFC 4331 quota; ctx.usage is loaded by PROPFIND when these are asked for.
  [d('quota-used-bytes')]: (x, r) => { const used = usage(x, r); return used === undefined ? undefined : String(used); },
  [d('quota-available-bytes')]: (x, r) => {
    const used = usage(x, r, true);
    return used === undefined || !x.config.quotaBytes ? undefined : String(Math.max(0, x.config.quotaBytes - used));
  },

  // Only returned when explicitly requested (see EXPLICIT_ONLY).
  [c('calendar-data')]: (x, r) => {
    if (r.kind !== 'calobj') return undefined;
    const spec = x.dataSpec?.get(c('calendar-data'));
    const source = wantsNoTimezones(x.req.headers) ? stripKnownTimezones(r.object.data) : r.object.data;
    return spec ? renderCalendarData(spec, source) : source;
  },
  [card('address-data')]: (x, r) => {
    if (r.kind !== 'card') return undefined;
    const spec = x.dataSpec?.get(card('address-data'));
    return spec ? renderAddressData(spec, r.object.data) : r.object.data;
  },
};

export const DATA_PROPS = new Set([c('calendar-data'), card('address-data')]);
export const QUOTA_PROPS = new Set([d('quota-used-bytes'), d('quota-available-bytes')]);
export const EXPLICIT_ONLY = new Set([...DATA_PROPS, ...QUOTA_PROPS]);

const isLockable = (r) => isObject(r) || isCollectionKind(r);

// Quota is accounted per user: homes report the user's total, collections their own share.
function usage(x, r, forQuota = false) {
  if (!x.usage) return undefined;
  if (isCollectionKind(r)) return forQuota ? x.usage.total : x.usage.byCollection.get(r.collection.id) ?? 0;
  if (r.kind === 'calhome' || r.kind === 'abhome') return x.usage.total;
  return undefined;
}

export const deadKey = (r) => r.segments.join('/');

export function propValue(ctx, r, tag) {
  const live = PROPS[tag];
  if (live) return live(ctx, r);
  const json = ctx.deadProps?.get(deadKey(r))?.get(tag);
  return json === undefined ? undefined : thawNode(json).children;
}

export const deadPropTags = (ctx, r) => [...(ctx.deadProps?.get(deadKey(r))?.keys() ?? [])];

/** Properties a client may change with PROPPATCH / MKCOL, mapped to collection columns. */
export const WRITABLE = {
  calendar: {
    [d('displayname')]: 'displayname',
    [c('calendar-description')]: 'description',
    [ic('calendar-color')]: 'color',
    [ic('calendar-order')]: 'sort_order',
    [c('calendar-timezone')]: 'timezone',
  },
  addressbook: {
    [d('displayname')]: 'displayname',
    [card('addressbook-description')]: 'description',
  },
};
