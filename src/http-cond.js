// HTTP conditional requests, ranges (RFC 9110 / 7232 / 7233) and the Prefer header (RFC 7240 / 8144).

const splitTags = (header) => header.split(',').map((t) => t.trim()).filter(Boolean);
const strong = (tag) => tag.replace(/^W\//, '') === tag ? tag : null;

/** Entity-tag lists: `*` matches any existing representation; `weak` allows W/ tags (If-None-Match). */
function listMatches(header, etag, { weak }) {
  if (header.trim() === '*') return etag != null;
  if (etag == null) return false;
  const quoted = `"${etag}"`;
  return splitTags(header).some((t) => (weak ? t.replace(/^W\//, '') === quoted : strong(t) === quoted));
}

const httpDate = (header) => {
  const ms = Date.parse(header);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * RFC 9110 section 13.2.2 evaluation order.
 * state: { etag: string|null, lastModified: seconds|null }; returns 200 (proceed), 304 or 412.
 */
export function evaluatePreconditions(headers, state, method) {
  const safe = method === 'GET' || method === 'HEAD';
  const ifMatch = headers['if-match'];
  const ifNoneMatch = headers['if-none-match'];
  if (ifMatch !== undefined) {
    if (!listMatches(ifMatch, state.etag, { weak: false })) return 412;
  } else if (headers['if-unmodified-since'] !== undefined && state.lastModified != null) {
    const since = httpDate(headers['if-unmodified-since']);
    if (since !== null && state.lastModified * 1000 > since) return 412;
  }
  if (ifNoneMatch !== undefined) {
    if (listMatches(ifNoneMatch, state.etag, { weak: true })) return safe ? 304 : 412;
  } else if (safe && headers['if-modified-since'] !== undefined && state.lastModified != null) {
    const since = httpDate(headers['if-modified-since']);
    if (since !== null && state.lastModified * 1000 <= since) return 304;
  }
  return 200;
}

/**
 * Single byte range of `size` bytes: { start, end } inclusive, 'unsatisfiable', or null to serve the whole body.
 * Multiple ranges are ignored (allowed by RFC 9110 section 14.2).
 */
export function parseRange(headers, size, etag, lastModified) {
  const header = headers.range;
  if (!header) return null;
  const ifRange = headers['if-range'];
  if (ifRange !== undefined) {
    const ok = ifRange.trim().startsWith('"')
      ? ifRange.trim() === `"${etag}"`
      : httpDate(ifRange) === lastModified * 1000;
    if (!ok) return null;
  }
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  return start >= size ? 'unsatisfiable' : { start, end };
}

/** Parses Prefer into a Map of token -> value (RFC 7240). */
export function parsePrefer(header) {
  const prefs = new Map();
  for (const part of (header ?? '').split(',')) {
    const [token, value] = part.split(';')[0].split('=').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (token) prefs.set(token.toLowerCase(), value ?? '');
  }
  return prefs;
}
