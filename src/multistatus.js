import { d } from './ns.js';
import { el } from './xml.js';
import { hrefOf, propValue, deadPropTags, PROPS, EXPLICIT_ONLY } from './resources.js';

const STATUS_TEXT = {
  200: 'OK', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 423: 'Locked', 424: 'Failed Dependency', 507: 'Insufficient Storage',
};
export const statusLine = (code) => `HTTP/1.1 ${code} ${STATUS_TEXT[code]}`;

const hrefEl = (h) => el(d('href'), null, h);

export const propstat = (code, props, error = null) =>
  el(d('propstat'), null, el(d('prop'), null, props), el(d('status'), null, statusLine(code)), error && el(d('error'), null, error));

export function makeResponse(href, found, missing = []) {
  const propstats = [];
  if (found.length || !missing.length) propstats.push(propstat(200, found.map(([tag, value]) => el(tag, null, value))));
  if (missing.length) propstats.push(propstat(404, missing.map((tag) => el(tag))));
  return el(d('response'), null, hrefEl(href), propstats);
}

export const statusResponse = (href, code, error = null, description = null) =>
  el(d('response'), null, hrefEl(href), el(d('status'), null, statusLine(code)), error && el(d('error'), null, error),
    description && el(d('responsedescription'), null, description));

/** mode: 'prop' (explicit names), 'allprop' (names = extra `include` properties) or 'propname'. */
export function propResponse(ctx, r, mode, names = []) {
  const found = [];
  const missing = [];
  if (mode === 'prop') {
    for (const tag of names) {
      const value = propValue(ctx, r, tag);
      if (value === undefined) missing.push(tag);
      else found.push([tag, value]);
    }
  } else {
    for (const tag of Object.keys(PROPS)) {
      if (EXPLICIT_ONLY.has(tag)) continue;
      const value = PROPS[tag](ctx, r);
      if (value !== undefined) found.push([tag, mode === 'propname' ? [] : value]);
    }
    for (const tag of deadPropTags(ctx, r)) found.push([tag, mode === 'propname' ? [] : propValue(ctx, r, tag)]);
    for (const tag of names) {
      if (found.some(([t]) => t === tag)) continue;
      const value = propValue(ctx, r, tag);
      if (value === undefined) missing.push(tag);
      else found.push([tag, value]);
    }
  }
  return makeResponse(hrefOf(ctx, r), found, missing);
}

export const multistatus = (responses, ...extra) => el(d('multistatus'), null, responses, extra);

/** Prefer: return=minimal (RFC 8144): drop 404 / 403 propstats and responses left without any property. */
export function minimize(tree) {
  const isFailure = (ps) => / (403|404) /.test(ps.children.find((ch) => ch.tag === d('status'))?.children[0] ?? '');
  tree.children = tree.children.filter((response) => {
    if (response.tag !== d('response')) return true;
    const propstats = response.children.filter((ch) => ch.tag === d('propstat'));
    if (!propstats.length) return true;
    response.children = response.children.filter((ch) => ch.tag !== d('propstat') || !isFailure(ch));
    return response.children.some((ch) => ch.tag === d('propstat'));
  });
  return tree;
}
