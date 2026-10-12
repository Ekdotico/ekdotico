// A time as every screen shows it, in a zone: `9 Oct 2026, 07:52` (the owner's
// decision of 9 October 2026). Written out here and not taken from the code
// under test: the numbers are the zone's, and the month is one of twelve fixed
// English words, whatever the locale of the browser.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shown(iso: string, timeZone: string): string {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map(({ type, value }) => [type, value]),
  );
  return `${Number(part.day)} ${MONTHS[Number(part.month) - 1]} ${part.year}, ${part.hour}:${part.minute}`;
}
