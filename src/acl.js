// RFC 3744 reports. Principals are limited to the signed-in user, so searches only ever see the caller's own principal.
import { d, c } from './ns.js';
import { el, childOf, childrenOf } from './xml.js';
import { davError } from './errors.js';
import { multistatus, propResponse } from './multistatus.js';
import { listChildren, principalResource, principalPath, propValue } from './resources.js';

const flatText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatText).join(' ');
  return flatText(value.children);
};

const hrefsOf = (value) => {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.tag === d('href')) out.push(flatText(v.children).trim());
      else walk(v.children);
    }
  };
  walk(value);
  return out;
};

const SEARCHABLE = [
  [d('displayname'), 'Display name'],
  [c('calendar-user-address-set'), 'Calendar user address'],
];

export const principalSearchPropertySet = () => el(d('principal-search-property-set'), null, SEARCHABLE.map(([tag, text]) =>
  el(d('principal-search-property'), null, el(d('prop'), null, el(tag)), el(d('description'), { 'xml:lang': 'en' }, text))));

/** Resources the report looks at: the request resource, plus its members for Depth: 1. */
async function scope(ctx, r) {
  const depth = (ctx.req.headers.depth ?? '0').trim();
  const list = [r];
  if (depth !== '0' && r.isCollection) list.push(...await listChildren(ctx, r));
  return list;
}

const isPrincipalSpace = (r) => r.kind === 'root' || r.kind === 'principals' || r.kind === 'principal';

export async function principalMatch(ctx, r, root, tags) {
  const self = childOf(root, d('self'));
  const property = childOf(root, d('principal-property'))?.children[0];
  if (!self && !property) throw davError(400, el(d('principal-match')));
  const me = principalPath(ctx);
  const matched = (await scope(ctx, r)).filter((x) => {
    if (self) return x.kind === 'principal';
    return hrefsOf(propValue(ctx, x, property.tag)).includes(me);
  });
  return multistatus(matched.map((x) => propResponse(ctx, x, 'prop', tags)));
}

export async function principalPropertySearch(ctx, r, root, tags) {
  const anyOf = (root.attrs.test ?? 'allof').toLowerCase() === 'anyof';
  const searches = childrenOf(root, d('property-search')).map((s) => ({
    tags: (childOf(s, d('prop'))?.children ?? []).map((n) => n.tag),
    text: (childOf(s, d('match'))?.text ?? '').toLowerCase(),
  }));
  if (!searches.length) throw davError(400, el(d('principal-property-search')));
  if (!childOf(root, d('apply-to-principal-collection-set')) && !isPrincipalSpace(r)) return multistatus([]);
  const principal = principalResource(ctx.user.username);
  const hit = (s) => s.tags.some((tag) => flatText(propValue(ctx, principal, tag)).toLowerCase().includes(s.text));
  const ok = anyOf ? searches.some(hit) : searches.every(hit);
  return multistatus(ok ? [propResponse(ctx, principal, 'prop', tags)] : []);
}

export async function aclPrincipalPropSet(ctx, r, root, tags) {
  if (!r.exists) return multistatus([]);
  return multistatus([propResponse(ctx, principalResource(ctx.user.username), 'prop', tags)]);
}

export const isAclReport = (tag) => [d('principal-match'), d('principal-property-search'), d('principal-search-property-set'), d('acl-principal-prop-set')].includes(tag);
