// Parser for the RFC 5545 (iCalendar) / RFC 6350 (vCard) content-line syntax.

export class ParseError extends Error {}

const MAX_NESTING = 16;

export function unfold(text) {
  const lines = [];
  for (const line of text.replace(/\r\n|\r/g, '\n').split('\n')) {
    if ((line[0] === ' ' || line[0] === '\t') && lines.length) lines[lines.length - 1] += line.slice(1);
    else if (line !== '') lines.push(line);
  }
  return lines;
}

function parseLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  if (i >= n) throw new ParseError(`invalid content line: ${line.slice(0, 40)}`);
  let name = line.slice(0, i).toUpperCase();
  const dot = name.indexOf('.'); // vCard group prefix, e.g. item1.EMAIL
  let group = null;
  if (dot >= 0) { group = name.slice(0, dot); name = name.slice(dot + 1); }

  const params = Object.create(null);
  while (line[i] === ';') {
    i++;
    const ps = i;
    while (i < n && line[i] !== '=' && line[i] !== ';' && line[i] !== ':') i++;
    let pname = line.slice(ps, i).toUpperCase();
    const values = [];
    if (line[i] === '=') {
      i++;
      for (;;) {
        let v;
        if (line[i] === '"') {
          const e = line.indexOf('"', i + 1);
          if (e < 0) throw new ParseError('unterminated quoted parameter value');
          v = line.slice(i + 1, e);
          i = e + 1;
        } else {
          const s = i;
          while (i < n && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') i++;
          v = line.slice(s, i);
        }
        values.push(v);
        if (line[i] === ',') { i++; continue; }
        break;
      }
    } else {
      values.push(pname); // vCard 2.1 bare parameter, e.g. TEL;WORK;VOICE:
      pname = 'TYPE';
    }
    (params[pname] ??= []).push(...values);
  }
  if (line[i] !== ':') throw new ParseError(`invalid content line: ${line.slice(0, 40)}`);
  return { name, params, value: line.slice(i + 1), group };
}

/** Parses one component tree: { name, props: [{name, params, value}], comps: [] } */
export function parseComponent(text) {
  const stack = [];
  let root = null;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (p.name === 'BEGIN') {
      const comp = { name: p.value.trim().toUpperCase(), props: [], comps: [] };
      if (stack.length) stack[stack.length - 1].comps.push(comp);
      else if (root) throw new ParseError('multiple top-level components');
      else root = comp;
      stack.push(comp);
      if (stack.length > MAX_NESTING) throw new ParseError('components nested too deeply');
    } else if (p.name === 'END') {
      const comp = stack.pop();
      if (!comp || comp.name !== p.value.trim().toUpperCase()) throw new ParseError('mismatched END');
    } else {
      if (!stack.length) throw new ParseError('content outside of component');
      stack[stack.length - 1].props.push(p);
    }
  }
  if (!root || stack.length) throw new ParseError('unterminated component');
  return root;
}

export const getProp = (comp, name) => comp.props.find((p) => p.name === name) ?? null;
export const getProps = (comp, name) => comp.props.filter((p) => p.name === name);

export function unescapeText(v) {
  return v.replace(/\\([nN,;\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

const paramText = (v) => (/[;:,]/.test(v) ? `"${v}"` : v);

function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export function formatProp(p) {
  const params = Object.entries(p.params).map(([k, v]) => `;${k}=${v.map(paramText).join(',')}`).join('');
  return fold(`${p.group ? `${p.group}.` : ''}${p.name}${params}:${p.value}`);
}

/** Serializes a parsed component tree back to iCalendar / vCard text with CRLF line ends. */
export function serializeComponent(comp) {
  const lines = [`BEGIN:${comp.name}`];
  for (const p of comp.props) lines.push(formatProp(p));
  for (const sub of comp.comps) lines.push(serializeComponent(sub).replace(/\r\n$/, ''));
  lines.push(`END:${comp.name}`);
  return `${lines.join('\r\n')}\r\n`;
}
