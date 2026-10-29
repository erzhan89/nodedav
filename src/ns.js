export const NS_DAV = 'DAV:';
export const NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const NS_CARDDAV = 'urn:ietf:params:xml:ns:carddav';
export const NS_CS = 'http://calendarserver.org/ns/';
export const NS_ICAL = 'http://apple.com/ns/ical/';

// Clark-notation tag builders: d('href') -> '{DAV:}href'
export const d = (name) => `{${NS_DAV}}${name}`;
export const c = (name) => `{${NS_CALDAV}}${name}`;
export const card = (name) => `{${NS_CARDDAV}}${name}`;
export const cs = (name) => `{${NS_CS}}${name}`;
export const ic = (name) => `{${NS_ICAL}}${name}`;
