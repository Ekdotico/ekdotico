// The one form of a date and a time that a person reads, on every screen and
// in every email (the owner's decision of 9 October 2026): `9 Oct 2026, 14:05`.
// The day without a leading zero, the month as three English letters, the
// year, a comma, and the time on the 24-hour clock to the minute.
//
// The words are fixed here and are never taken from the locale of the server
// or of the browser, so every reader is given the same spelling. The time zone
// alone varies: the reader's own on a screen (NFR-I18-06), and UTC, which is
// then said, where the zone of the reader is not known, as in an email.
//
// What a machine reads (the `dateTime` of a `<time>` element, a log, a stored
// value) stays ISO 8601 and is not written here.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (value: number) => String(value).padStart(2, '0');

/**
 * `at` to the minute, never rounded up. In the zone of the process that calls
 * (in a browser, the reader's own), or in UTC with ` UTC` after it.
 */
export function dateText(at: Date, zone: 'local' | 'utc' = 'local'): string {
  return zone === 'utc'
    ? `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`
    : `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}, ${two(at.getHours())}:${two(at.getMinutes())}`;
}
