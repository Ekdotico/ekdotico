// Every end-to-end file runs under the Content-Security-Policy and fails where
// a page breaks it (tests/e2e/fixtures.ts). A file that took `test` from the
// runner itself would run unwatched, and fails here.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const specs = globSync('tests/e2e/**/*.spec.ts');

describe('the end-to-end files', () => {
  it('are found', () => {
    expect(specs.length).toBeGreaterThan(5);
  });

  it.each(specs)('%s takes its test from the fixture that watches the policy', (spec) => {
    const source = readFileSync(spec, 'utf8');
    expect(source).toMatch(/import \{[^}]*\btest\b[^}]*\} from '\.\/fixtures\.ts';/);
    expect(source).not.toMatch(/import \{[^}]*\b(test|expect)\b[^}]*\} from '@playwright\/test';/);
  });

  it('are watched by a fixture that is always on, and that fails a test for what it saw', () => {
    const fixture = readFileSync('tests/e2e/fixtures.ts', 'utf8');
    expect(fixture).toContain('{ auto: true }');
    expect(fixture).toContain('if (!violations.expected) expect(violations.seen');
  });
});
