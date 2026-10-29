import { ParseError, parseComponent, getProp } from './ical.js';

export class VcardError extends Error {}

/** Validates an address object resource (single vCard) and extracts its UID (may be null). */
export function analyzeVcard(text) {
  let root;
  try {
    root = parseComponent(text);
  } catch (e) {
    if (e instanceof ParseError) throw new VcardError(e.message);
    throw e;
  }
  if (root.name !== 'VCARD') throw new VcardError('not a VCARD');
  const version = getProp(root, 'VERSION')?.value.trim();
  if (!['2.1', '3.0', '4.0'].includes(version)) throw new VcardError('missing or unsupported VERSION');
  return { uid: getProp(root, 'UID')?.value.trim() || null, root };
}
