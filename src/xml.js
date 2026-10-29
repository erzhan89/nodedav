import { NS_DAV, NS_CALDAV, NS_CARDDAV, NS_CS, NS_ICAL } from './ns.js';

export class XmlError extends Error {}

const MAX_DEPTH = 64;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isInteger(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        throw new XmlError(`invalid character reference ${m}`);
      }
      return String.fromCodePoint(cp);
    }
    if (Object.hasOwn(PREDEFINED, e)) return PREDEFINED[e];
    throw new XmlError(`unsupported entity ${m}`);
  });
}

/**
 * Minimal namespace-aware XML parser. DTDs (and therefore custom entities)
 * are rejected, which rules out XXE and entity-expansion attacks.
 * Nodes: { tag: '{ns}local', ns, name, attrs, children: Node[], text: string }
 */
export function parseXml(input) {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = src.length;
  const nameRe = /<([^\s/>]+)/y;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const baseScope = Object.assign(Object.create(null), { xml: XML_NS });
  const stack = [];
  let root = null;
  let pos = 0;

  while (pos < n) {
    const lt = src.indexOf('<', pos);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > pos) {
      const raw = src.slice(pos, textEnd);
      if (stack.length) stack[stack.length - 1].node.text += decodeEntities(raw);
      else if (raw.trim() !== '') throw new XmlError('text outside of root element');
    }
    if (lt === -1) break;
    pos = lt;

    if (src.startsWith('<!--', pos)) {
      const end = src.indexOf('-->', pos + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      pos = end + 3;
    } else if (src.startsWith('<![CDATA[', pos)) {
      const end = src.indexOf(']]>', pos + 9);
      if (end === -1 || !stack.length) throw new XmlError('invalid CDATA section');
      stack[stack.length - 1].node.text += src.slice(pos + 9, end);
      pos = end + 3;
    } else if (src.startsWith('<?', pos)) {
      const end = src.indexOf('?>', pos + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      pos = end + 2;
    } else if (src.startsWith('<!', pos)) {
      throw new XmlError('DTD / DOCTYPE declarations are not allowed');
    } else if (src.startsWith('</', pos)) {
      const end = src.indexOf('>', pos);
      if (end === -1) throw new XmlError('unterminated end tag');
      const qname = src.slice(pos + 2, end).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlError(`unexpected end tag </${qname}>`);
      pos = end + 1;
    } else {
      nameRe.lastIndex = pos;
      const nm = nameRe.exec(src);
      if (!nm) throw new XmlError('malformed start tag');
      const qname = nm[1];
      let p = nameRe.lastIndex;
      let selfClosing = false;
      const rawAttrs = [];
      for (;;) {
        while (p < n && /\s/.test(src[p])) p++;
        if (p >= n) throw new XmlError('unterminated start tag');
        if (src[p] === '>') { p++; break; }
        if (src[p] === '/' && src[p + 1] === '>') { selfClosing = true; p += 2; break; }
        attrRe.lastIndex = p;
        const am = attrRe.exec(src);
        if (!am) throw new XmlError('malformed attribute');
        rawAttrs.push([am[1], decodeEntities(am[2] ?? am[3])]);
        p = attrRe.lastIndex;
      }
      pos = p;

      let scope = stack.length ? stack[stack.length - 1].scope : baseScope;
      const attrs = {};
      let copied = false;
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) {
          if (!copied) { scope = Object.assign(Object.create(null), scope); copied = true; }
          scope[k === 'xmlns' ? '' : k.slice(6)] = v;
        } else {
          const colon = k.indexOf(':');
          attrs[colon < 0 ? k : k.slice(colon + 1)] = v;
        }
      }
      const colon = qname.indexOf(':');
      const prefix = colon < 0 ? '' : qname.slice(0, colon);
      const name = colon < 0 ? qname : qname.slice(colon + 1);
      const ns = scope[prefix];
      if (ns === undefined && prefix) throw new XmlError(`unbound namespace prefix "${prefix}"`);

      const node = { tag: ns ? `{${ns}}${name}` : name, ns: ns ?? '', name, attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else if (root) throw new XmlError('multiple root elements');
      else root = node;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError('document too deeply nested');
        stack.push({ node, qname, scope });
      }
    }
  }
  if (stack.length || !root) throw new XmlError('unexpected end of document');
  return root;
}

export const childOf = (node, tag) => node?.children.find((ch) => ch.tag === tag) ?? null;
export const childrenOf = (node, tag) => node.children.filter((ch) => ch.tag === tag);

/** Build an element tree for serialization. Children may be nodes, strings or (nested) arrays. */
export function el(tag, attrs, ...children) {
  return {
    tag,
    attrs: attrs ?? {},
    children: children.flat(Infinity).filter((ch) => ch != null && ch !== false && ch !== ''),
  };
}

/** Round-trips a parsed element (names, text, children; not attributes) through JSON, for dead properties and lock owners. */
const plain = (n) => ({ tag: n.tag, text: n.text, children: n.children.map(plain) });
export const freezeNode = (n) => JSON.stringify(plain(n));
export function thawNode(json) {
  const build = (p) => el(p.tag, null, p.text, p.children.map(build));
  return build(JSON.parse(json));
}

const PREFIXES = {
  [NS_DAV]: 'D',
  [NS_CALDAV]: 'C',
  [NS_CARDDAV]: 'CR',
  [NS_CS]: 'CS',
  [NS_ICAL]: 'IC',
};

function splitTag(tag) {
  const m = /^\{([^}]*)\}(.+)$/.exec(tag);
  return m ? [m[1], m[2]] : ['', tag];
}

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const escText = (s) =>
  s.replace(INVALID_XML_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const escAttr = (s) =>
  escText(String(s)).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

export function serialize(root) {
  const used = new Map();
  let auto = 0;
  const collect = (node) => {
    if (typeof node === 'string') return;
    const [ns] = splitTag(node.tag);
    if (ns && !used.has(ns)) used.set(ns, PREFIXES[ns] ?? `ns${auto++}`);
    node.children.forEach(collect);
  };
  collect(root);

  const out = ['<?xml version="1.0" encoding="utf-8"?>\n'];
  const write = (node, isRoot) => {
    if (typeof node === 'string') { out.push(escText(node)); return; }
    const [ns, name] = splitTag(node.tag);
    const q = ns ? `${used.get(ns)}:${name}` : name;
    out.push(`<${q}`);
    if (isRoot) for (const [uri, prefix] of used) out.push(` xmlns:${prefix}="${escAttr(uri)}"`);
    for (const [k, v] of Object.entries(node.attrs)) out.push(` ${k}="${escAttr(v)}"`);
    if (!node.children.length) { out.push('/>'); return; }
    out.push('>');
    for (const ch of node.children) write(ch, false);
    out.push(`</${q}>`);
  };
  write(root, true);
  return out.join('');
}
