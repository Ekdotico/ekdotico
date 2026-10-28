// The six procedures and the rotation as checklists with a place for each record (docs/plan/slice-27.md, S27-7),
// and the tool that makes a record from one (scripts/record.ts).
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newRecord, PROCEDURES, RUNS, whatIsLeft } from '../../scripts/record.ts';

// The steps the build-phases page gives each procedure (draft register, ee3a637).
const STEPS: Record<string, number> = {
  'editor-performance': 10,
  'health-checks': 8,
  'connection-limit': 8,
  accessibility: 8,
  browsers: 4,
  'backup-and-restore': 13,
};

describe.each(Object.entries(PROCEDURES))('%s', (name, path) => {
  const text = readFileSync(path, 'utf8');

  it('has a place for its records', () => {
    expect(existsSync(join(RUNS, name))).toBe(true);
    expect(readFileSync('docs/procedures/README.md', 'utf8')).toContain(`docs/records/runs/${name}/`);
  });

  it('is a checklist: a box for each step, numbered without a gap, and a fixed sentence of when it is met', () => {
    if (name === 'secret-rotation') {
      expect(whatIsLeft(text).length).toBeGreaterThan(10);
      return;
    }
    const numbers = [...text.matchAll(/^- \[ \] (\d+)\. /gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: STEPS[name]! }, (_, at) => at + 1));
    expect(text).toMatch(/^## Met when\n\n\S/m);
    expect(text).toMatch(/^Met: ____/m);
  });

  it('never holds a value of a secret', () => {
    expect(text).not.toMatch(/AUTH_SECRET=[A-Za-z0-9_-]{8,}|PASSWORD=[^….\s]{8,}/);
  });
});

describe('scripts/record.ts', () => {
  it('makes a record that is not complete, shows the steps, and never replaces one', () => {
    const runs = mkdtempSync(join(tmpdir(), 'ekdotico-runs-'));
    const target = newRecord('browsers', '0.1.0', new Date('2026-11-02T10:00:00Z'), runs);
    expect(target).toBe(join(runs, 'browsers', '2026-11-02-0.1.0.md'));
    const record = readFileSync(target, 'utf8');
    expect(record).toMatch(/^# Record: browsers, release 0\.1\.0, 2026-11-02$/m);
    expect(record).toContain('Chrome 120, Firefox 120, Safari 17, Edge 120');
    expect(whatIsLeft(record).length).toBeGreaterThan(5);
    expect(() => newRecord('browsers', '0.1.0', new Date('2026-11-02T23:00:00Z'), runs)).toThrow(
      /never replaced/,
    );
    expect(readdirSync(join(runs, 'browsers'))).toHaveLength(1);
  });

  it('refuses a procedure that does not exist and a release that is no version', () => {
    expect(() => newRecord('nothing', '0.1.0')).toThrow(/No procedure/);
    expect(() => newRecord('browsers', 'next')).toThrow(/version/);
  });

  it('says a record is complete only when every box is ticked and every field filled', () => {
    expect(whatIsLeft('- [x] 1. done: yes\nMet: yes')).toEqual([]);
    expect(whatIsLeft('- [ ] 1. not done')).toHaveLength(1);
    expect(whatIsLeft('- [x] 1. done: ____')).toHaveLength(1);
  });
});
