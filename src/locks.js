// WebDAV locking (RFC 4918 section 6-7, 9.10-9.11, 10.4): the If header, lock bookkeeping and lock XML.
import { randomUUID } from 'node:crypto';
import { d } from './ns.js';
import { el, thawNode } from './xml.js';
import { HttpError, davError } from './errors.js';
import { hrefFor, parsePath, resolve } from './resources.js';

export const pathKey = (segments) => segments.join('/');
const segmentsOf = (path) => path.split('/');

export const lockCovers = (lock, path) => lock.path === path || (lock.depth < 0 && path.startsWith(`${lock.path}/`));
export const locksOn = (ctx, path) => (ctx.locks ?? []).filter((l) => lockCovers(l, path));
const locksBelow = (ctx, path) => (ctx.locks ?? []).filter((l) => l.path.startsWith(`${path}/`));

export const newToken = () => `opaquelocktoken:${randomUUID()}`;

export async function ensureLocks(ctx) {
  ctx.locks ??= await ctx.store.listLocks(ctx.user.id);
  return ctx.locks;
}

// ---- If header ---------------------------------------------------------------

/** Parses `If` into [{ tag: string|null, conditions: [{ not, token?, etag? }] }]; every list is a conjunction. */
export function parseIfHeader(value) {
  const bad = () => new HttpError(400, 'Malformed If header');
  const lists = [];
  const n = value.length;
  let i = 0;
  let tag = null;
  const skip = () => { while (i < n && /\s/.test(value[i])) i++; };
  skip();
  while (i < n) {
    if (value[i] === '<') {
      const end = value.indexOf('>', i);
      if (end < 0) throw bad();
      tag = value.slice(i + 1, end);
      i = end + 1;
    } else if (value[i] === '(') {
      i++;
      const conditions = [];
      for (;;) {
        skip();
        if (i >= n) throw bad();
        if (value[i] === ')') { i++; break; }
        let not = false;
        if (value.slice(i, i + 3).toLowerCase() === 'not') { not = true; i += 3; skip(); }
        if (value[i] === '<') {
          const end = value.indexOf('>', i);
          if (end < 0) throw bad();
          conditions.push({ not, token: value.slice(i + 1, end) });
          i = end + 1;
        } else if (value[i] === '[') {
          const end = value.indexOf(']', i);
          if (end < 0) throw bad();
          conditions.push({ not, etag: value.slice(i + 1, end).trim() });
          i = end + 1;
        } else {
          throw bad();
        }
      }
      if (!conditions.length) throw bad();
      lists.push({ tag, conditions });
    } else {
      throw bad();
    }
    skip();
  }
  if (!lists.length) throw bad();
  return lists;
}

async function stateOf(ctx, r) {
  return {
    etag: r?.exists && r.object ? `"${r.object.etag}"` : null,
    tokens: new Set(r ? locksOn(ctx, pathKey(r.segments)).map((l) => l.token) : []),
  };
}

async function resolveTag(ctx, tag) {
  try {
    const url = new URL(tag, 'http://localhost');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tag) && url.host !== ctx.req.headers.host) return null;
    return await resolve(ctx, parsePath(url.pathname, ctx.base));
  } catch {
    return null;
  }
}

/** Evaluates the If header against the request resource; sets ctx.submitted to every lock token it presents. */
export async function checkIf(ctx, r) {
  ctx.submitted = new Set();
  const header = ctx.req.headers.if;
  if (header === undefined) return;
  const lists = parseIfHeader(header);
  for (const l of lists) for (const cond of l.conditions) if (cond.token && !cond.not) ctx.submitted.add(cond.token);
  await ensureLocks(ctx);
  const states = new Map();
  for (const list of lists) {
    const key = list.tag ?? '';
    if (!states.has(key)) states.set(key, await stateOf(ctx, list.tag ? await resolveTag(ctx, list.tag) : r));
    const state = states.get(key);
    const holds = list.conditions.every((cond) => {
      const match = cond.token !== undefined
        ? cond.token !== 'DAV:no-lock' && state.tokens.has(cond.token)
        : state.etag !== null && cond.etag === state.etag;
      return cond.not ? !match : match;
    });
    if (holds) return;
  }
  throw new HttpError(412, 'If header precondition failed');
}

/**
 * Throws 423 unless the request presented a token for every lock that protects the change.
 * `membership`: members are added to / removed from the parent. `subtree`: the resource and all below are affected.
 */
export function assertUnlocked(ctx, segments, { membership = false, subtree = false } = {}) {
  const path = pathKey(segments);
  const relevant = new Map();
  for (const l of locksOn(ctx, path)) relevant.set(l.token, l);
  if (membership && segments.length > 1) {
    const parent = pathKey(segments.slice(0, -1));
    for (const l of ctx.locks ?? []) if (l.path === parent) relevant.set(l.token, l);
  }
  if (subtree) for (const l of locksBelow(ctx, path)) relevant.set(l.token, l);

  const byPath = Map.groupBy([...relevant.values()], (l) => l.path);
  const unsatisfied = [...byPath.entries()].filter(([, locks]) => !locks.some((l) => ctx.submitted?.has(l.token)));
  if (unsatisfied.length) {
    const hrefs = unsatisfied.map(([p]) => el(d('href'), null, hrefFor(ctx.base, segmentsOf(p), segmentsOf(p).length <= 3)));
    throw davError(423, el(d('lock-token-submitted'), null, hrefs));
  }
}

// ---- XML ---------------------------------------------------------------------

export function activeLock(ctx, lock) {
  const segs = segmentsOf(lock.path);
  const remaining = Math.max(0, lock.expires_at - Math.floor(Date.now() / 1000));
  return el(d('activelock'), null,
    el(d('locktype'), null, el(d('write'))),
    el(d('lockscope'), null, el(d(lock.exclusive ? 'exclusive' : 'shared'))),
    el(d('depth'), null, lock.depth < 0 ? 'infinity' : '0'),
    lock.owner ? el(d('owner'), null, thawNode(lock.owner).children) : null,
    el(d('timeout'), null, `Second-${remaining}`),
    el(d('locktoken'), null, el(d('href'), null, lock.token)),
    el(d('lockroot'), null, el(d('href'), null, hrefFor(ctx.base, segs, segs.length <= 3))));
}

export const SUPPORTED_LOCK = [
  el(d('lockentry'), null, el(d('lockscope'), null, el(d('exclusive'))), el(d('locktype'), null, el(d('write')))),
  el(d('lockentry'), null, el(d('lockscope'), null, el(d('shared'))), el(d('locktype'), null, el(d('write')))),
];

/** Locks visible on a resource (its own and inherited from depth-infinity ancestors) as a lockdiscovery value. */
export const lockDiscovery = (ctx, r) => locksOn(ctx, pathKey(r.segments)).map((l) => activeLock(ctx, l));

export function parseTimeout(header, config) {
  let secs = config.lockTimeoutDefault;
  for (const part of (header ?? '').split(',')) {
    const t = part.trim();
    const m = /^Second-(\d{1,10})$/i.exec(t);
    if (m) { secs = Number(m[1]); break; }
    if (/^infinite$/i.test(t)) { secs = config.lockTimeoutMax; break; }
  }
  return Math.min(Math.max(secs, 1), config.lockTimeoutMax);
}

/** Existing locks that conflict with a new lock on `path`. */
export function conflictingLocks(ctx, path, { exclusive, deep }) {
  const found = [...locksOn(ctx, path), ...(deep ? locksBelow(ctx, path) : [])];
  return found.filter((l) => exclusive || l.exclusive);
}
