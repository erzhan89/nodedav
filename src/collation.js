// Text collations for CalDAV / CardDAV text-match (RFC 4790).
export const COLLATIONS = ['i;ascii-casemap', 'i;octet', 'i;unicode-casemap'];

const asciiFold = (s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
const unicodeFold = (s) => s.normalize('NFKC').toLocaleLowerCase('en-US');

/** Returns a fold function for the collation name, or null when it is not supported. */
export function folder(name) {
  switch ((name ?? 'i;unicode-casemap').toLowerCase()) {
    case 'i;octet': return (s) => s;
    case 'i;ascii-casemap': return asciiFold;
    case 'i;unicode-casemap': return unicodeFold;
    default: return null;
  }
}
