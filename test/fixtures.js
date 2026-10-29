export const ics = (uid, start = '20300101T100000Z', extra = '') => `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//test//EN\r
BEGIN:VEVENT\r
UID:${uid}\r
DTSTAMP:20240101T000000Z\r
DTSTART:${start}\r
DURATION:PT1H\r
SUMMARY:Event ${uid}\r
${extra}END:VEVENT\r
END:VCALENDAR\r
`;

export const vcf = (uid, fn) => `BEGIN:VCARD\r
VERSION:3.0\r
UID:${uid}\r
FN:${fn}\r
N:${fn};;;;\r
END:VCARD\r
`;
