// The one form of a date and a time that a person reads (the owner's decision
// of 9 October 2026): `9 Oct 2026, 14:05`, and in UTC `9 Oct 2026, 14:05 UTC`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateText } from '../../src/lib/date-text.ts';

afterEach(() => vi.unstubAllEnvs());

describe('the text of a date', () => {
  it('writes the day without a leading zero, the year in four digits, and the time on the 24-hour clock', () => {
    expect(dateText(new Date('2026-10-09T14:05:00Z'), 'utc')).toBe('9 Oct 2026, 14:05 UTC');
    expect(dateText(new Date('2026-01-31T00:00:00Z'), 'utc')).toBe('31 Jan 2026, 00:00 UTC');
    expect(dateText(new Date('2027-03-02T09:07:00Z'), 'utc')).toBe('2 Mar 2027, 09:07 UTC');
    expect(dateText(new Date('2026-12-31T23:59:00Z'), 'utc')).toBe('31 Dec 2026, 23:59 UTC');
  });

  it('never rounds a minute up, and shows no seconds', () => {
    expect(dateText(new Date('2026-10-08T14:05:59.999Z'), 'utc')).toBe('8 Oct 2026, 14:05 UTC');
  });

  it('names each month in three English letters, September as Sep', () => {
    const months = Array.from({ length: 12 }, (_, month) =>
      dateText(new Date(Date.UTC(2026, month, 15, 12)), 'utc'),
    );
    expect(months).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
        (name) => `15 ${name} 2026, 12:00 UTC`,
      ),
    );
  });

  it('takes no word from the default locale of the process', () => {
    // Nothing that words a date by a locale is called: neither a formatter nor
    // a method of the date that takes one. (This file also passes with the
    // process started under a Greek locale, and the end-to-end test of the
    // list of documents runs in a browser whose locale is Greek.)
    const formatter = vi.spyOn(Intl, 'DateTimeFormat');
    const worded = (['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const).map((name) =>
      vi.spyOn(Date.prototype, name),
    );
    expect(dateText(new Date('2026-09-09T14:05:00Z'), 'utc')).toBe('9 Sep 2026, 14:05 UTC');
    expect(dateText(new Date('2026-09-09T14:05:00Z'))).toMatch(/^\d{1,2} Sep 2026, \d{2}:\d{2}$/);
    expect(formatter).not.toHaveBeenCalled();
    for (const method of worded) expect(method).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('writes the time of the zone it is called in, and says no zone', () => {
    const at = new Date('2026-10-09T14:05:00Z');
    vi.stubEnv('TZ', 'Pacific/Auckland');
    expect(dateText(at)).toBe('10 Oct 2026, 03:05');
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(dateText(at)).toBe('9 Oct 2026, 07:05');
    expect(dateText(at, 'local')).toBe('9 Oct 2026, 07:05');
  });
});
