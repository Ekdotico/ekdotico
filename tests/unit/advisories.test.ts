// NFR-IC-20; the owner's decision of 8 October 2026: an advisory is ignored
// only by its identifier, with a dated reason in the repository. The two lists
// are held to each other here: package.json, which pnpm reads, and
// docs/operations/advisories.md, which a person reads.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { pnpm } = JSON.parse(readFileSync('package.json', 'utf8'));
const ignored: string[] = [...(pnpm.auditConfig?.ignoreGhsas ?? []), ...(pnpm.auditConfig?.ignoreCves ?? [])];

// The rows of the table under "## Ignored": identifier, date, path, reason.
const section = readFileSync('docs/operations/advisories.md', 'utf8').split(/^## /m)[1] ?? '';
const rows = section
  .split('\n')
  .filter((line) => /^\|\s*(GHSA|CVE)-/.test(line))
  .map((line) => line.split('|').map((cell) => cell.trim()));

describe('the advisories that are ignored', () => {
  it('reads the section it means to', () => {
    expect(section.startsWith('Ignored')).toBe(true);
  });

  it('are the same in package.json and in the record, each once', () => {
    expect(rows.map((row) => row[1]).sort()).toEqual([...ignored].sort());
    expect(new Set(ignored).size).toBe(ignored.length);
  });

  it('each have a date, the path they arrive by, and a reason', () => {
    for (const [, id, date = '', path = '', reason = ''] of rows) {
      expect(date, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(date)), id).toBe(false);
      expect(path.length, id).toBeGreaterThan(10);
      expect(reason.length, id).toBeGreaterThan(40);
    }
  });

  it('pass over no severity and no kind of dependency in the check', () => {
    const workflow = readFileSync('.github/workflows/advisories.yml', 'utf8');
    const run = workflow.split('\n').filter((line) => /^\s*- run: pnpm audit/.test(line));
    expect(run.map((line) => line.trim())).toEqual(['- run: pnpm audit --audit-level low']);
  });

  it('overrides only to an exact version (NFR-IC-08)', () => {
    for (const [name, version] of Object.entries(pnpm.overrides ?? {})) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
