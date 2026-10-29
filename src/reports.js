import { d, c, card } from './ns.js';
import { el, childOf, childrenOf } from './xml.js';
import { HttpError, davError } from './errors.js';
import { parseComponent } from './ical.js';
import { matchCalendarFilter, matchCardFilter, calendarPrefilter, validateFilter } from './filters.js';
import { busyFromData, buildFreeBusy } from './freebusy.js';
import { parseDateFields, fieldsToUtc } from './dates.js';
import { OP } from './ops.js';
import {
  parsePath, hrefFor, objectResource, parseSyncToken, syncTokenUri, DATA_PROPS,
} from './resources.js';
import { validateDataSpec } from './projection.js';
import { multistatus, propResponse, statusResponse } from './multistatus.js';
import { principalMatch, principalPropertySearch, aclPrincipalPropSet, principalSearchPropertySet } from './acl.js';

/** Property names a report asks for; remembers calendar-data / address-data sub-elements for partial retrieval. */
function requestedProps(root, ctx) {
  const prop = childOf(root, d('prop'));
  if (!prop) return [d('getetag')];
  ctx.dataSpec = new Map();
  for (const n of prop.children) {
    if (DATA_PROPS.has(n.tag)) {
      validateDataSpec(n.tag, n);
      ctx.dataSpec.set(n.tag, n);
    }
  }
  return prop.children.map((n) => n.tag);
}
const wantsData = (tags) => tags.some((t) => DATA_PROPS.has(t));

async function calendarQuery(ctx, r, root) {
  const tags = requestedProps(root, ctx);
  const filter = childOf(root, c('filter'));
  if (!filter) throw new HttpError(400, 'calendar-query requires a filter');
  validateFilter(filter, c);
  const pre = calendarPrefilter(filter);
  const rows = await ctx.store.listObjects(r.collection.id, {
    withData: wantsData(tags) || !pre.trivial,
    componentType: pre.componentType,
    rangeStart: pre.rangeStart,
    rangeEnd: pre.rangeEnd,
  });
  const responses = [];
  for (const row of rows) {
    if (!pre.trivial) {
      let tree;
      try {
        tree = parseComponent(row.data);
      } catch {
        continue;
      }
      if (!matchCalendarFilter(filter, tree)) continue;
    }
    responses.push(propResponse(ctx, objectResource(r, row), 'prop', tags));
  }
  return multistatus(responses);
}

async function addressbookQuery(ctx, r, root) {
  const tags = requestedProps(root, ctx);
  const filter = childOf(root, card('filter'));
  const limit = parseInt(childOf(childOf(root, card('limit')), card('nresults'))?.text, 10);
  if (filter) validateFilter(filter, card);
  const rows = await ctx.store.listObjects(r.collection.id, { withData: true });
  const responses = [];
  for (const row of rows) {
    if (filter) {
      let tree;
      try {
        tree = parseComponent(row.data);
      } catch {
        continue;
      }
      if (!matchCardFilter(filter, tree)) continue;
    }
    if (limit > 0 && responses.length >= limit) {
      responses.push(statusResponse(hrefFor(ctx.base, r.segments, true), 507, el(d('number-of-matches-within-limits')), `Only the first ${limit} results are returned`));
      break;
    }
    responses.push(propResponse(ctx, objectResource(r, row), 'prop', tags));
  }
  return multistatus(responses);
}

async function multiget(ctx, r, root) {
  const tags = requestedProps(root, ctx);
  const hrefs = childrenOf(root, d('href')).map((n) => n.text.trim());
  const uris = hrefs.map((raw) => {
    try {
      const segs = parsePath(new URL(raw, 'http://localhost').pathname, ctx.base);
      const inCollection = segs.length === r.segments.length + 1 && r.segments.every((s, i) => s === segs[i]);
      return inCollection ? segs.at(-1) : null;
    } catch {
      return null;
    }
  });
  const rows = new Map((await ctx.store.getObjects(r.collection.id, uris.filter(Boolean))).map((row) => [row.uri, row]));
  return multistatus(hrefs.map((raw, i) => {
    const row = uris[i] && rows.get(uris[i]);
    return row ? propResponse(ctx, objectResource(r, row), 'prop', tags) : statusResponse(raw, 404);
  }));
}

async function syncCollection(ctx, r, root) {
  const tags = requestedProps(root, ctx);
  const level = childOf(root, d('sync-level'))?.text.trim();
  if (level && level !== '1') throw davError(403, el(d('sync-traversal-supported')));
  const tokenText = childOf(root, d('sync-token'))?.text.trim() ?? '';
  const { store } = ctx;
  const col = r.collection;
  const responses = [];

  if (!tokenText) {
    for (const row of await store.listObjects(col.id, { withData: wantsData(tags) })) {
      responses.push(propResponse(ctx, objectResource(r, row), 'prop', tags));
    }
  } else {
    const since = parseSyncToken(tokenText);
    if (since === null || since < 1 || since > col.sync_token) throw davError(403, el(d('valid-sync-token')));
    const changes = await store.changesSince(col.id, since);
    const live = new Map(
      (await store.getObjects(col.id, changes.filter((ch) => ch.operation !== OP.DELETED).map((ch) => ch.uri))).map((row) => [row.uri, row]),
    );
    for (const change of changes) {
      if (change.operation === OP.DELETED) {
        responses.push(statusResponse(hrefFor(ctx.base, [...r.segments, change.uri], false), 404));
      } else if (live.has(change.uri)) {
        responses.push(propResponse(ctx, objectResource(r, live.get(change.uri)), 'prop', tags));
      }
    }
  }
  return multistatus(responses, el(d('sync-token'), null, syncTokenUri(col.sync_token)));
}

function utcAttr(value) {
  const f = value && parseDateFields(value);
  if (!f || !f.utc) throw davError(403, el(c('valid-filter')));
  return fieldsToUtc(f, null);
}

// RFC 4791 7.10: the answer is a VFREEBUSY calendar, not a multistatus.
async function freeBusyQuery(ctx, r, root) {
  const range = childOf(root, c('time-range'));
  if (!range) throw new HttpError(400, 'free-busy-query requires a time-range');
  const start = utcAttr(range.attrs.start);
  const end = utcAttr(range.attrs.end);
  if (end <= start) throw davError(403, el(c('valid-filter')));
  const rows = await ctx.store.listObjects(r.collection.id, { withData: true, componentType: 'VEVENT', rangeStart: start, rangeEnd: end });
  const periods = busyFromData(rows.map((row) => row.data), start, end);
  return { raw: { contentType: 'text/calendar; charset=utf-8', body: buildFreeBusy({ start, end, periods }) } };
}

/** Dispatches a REPORT body to its handler and returns the multistatus element tree. */
export async function runReport(ctx, r, root) {
  if (root.tag === d('principal-search-property-set')) {
    if (r.kind !== 'principals' && r.kind !== 'root') throw davError(403, el(d('supported-report')));
    return { raw: { contentType: 'application/xml; charset=utf-8', tree: principalSearchPropertySet() } };
  }
  if (root.tag === d('principal-match')) return principalMatch(ctx, r, root, requestedProps(root, ctx));
  if (root.tag === d('principal-property-search')) return principalPropertySearch(ctx, r, root, requestedProps(root, ctx));
  if (root.tag === d('acl-principal-prop-set')) return aclPrincipalPropSet(ctx, r, root, requestedProps(root, ctx));
  if (r.kind === 'calendar' || r.kind === 'inbox') {
    if (root.tag === c('calendar-query')) return calendarQuery(ctx, r, root);
    if (root.tag === c('calendar-multiget')) return multiget(ctx, r, root);
    if (root.tag === c('free-busy-query') && r.kind === 'calendar') return freeBusyQuery(ctx, r, root);
    if (root.tag === d('sync-collection')) return syncCollection(ctx, r, root);
  } else if (r.kind === 'addressbook') {
    if (root.tag === card('addressbook-query')) return addressbookQuery(ctx, r, root);
    if (root.tag === card('addressbook-multiget')) return multiget(ctx, r, root);
    if (root.tag === d('sync-collection')) return syncCollection(ctx, r, root);
  }
  throw davError(403, el(d('supported-report')));
}
