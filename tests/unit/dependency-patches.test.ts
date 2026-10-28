// NFR-IC-10: a security patch for a direct dependency is applied within 14 days of disclosure
// (docs/records/dependency-patches.md). The log is held to its own arithmetic and to the rule.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rows = readFileSync('docs/records/dependency-patches.md', 'utf8')
  .split('\n')
  .filter((line) => /^\| GHSA-/.test(line))
  .map((line) =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  );

const DAY = 24 * 60 * 60 * 1000;

describe('the log of the 14 days', () => {
  it('has a row for each advisory, once', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row[0])).size).toBe(rows.length);
  });

  it.each(rows)(
    '%s: the days are the days between the two dates, and a direct dependency is within 14',
    (id, _package, direct, published, patched, days) => {
      const between = Math.round((Date.parse(patched!) - Date.parse(published!)) / DAY);
      expect(between, id).toBeGreaterThanOrEqual(0);
      expect(Number(days), id).toBe(between);
      expect(['yes', 'no']).toContain(direct);
      if (direct === 'yes') expect(between, id).toBeLessThanOrEqual(14);
    },
  );
});
