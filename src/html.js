class Safe {
  constructor(value) {
    this.value = value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** Marks a string as already-safe markup. Only use it with literals. */
export const raw = (s) => new Safe(String(s));

const render = (v) => {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return v == null || v === false ? '' : esc(v);
};

/** Tagged template that HTML-escapes every interpolated value unless it came from html`` or raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const toString = (safe) => safe.value;
