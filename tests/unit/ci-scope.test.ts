import { describe, expect, it } from 'vitest';
import { needsFull } from '../../scripts/ci/scope.mjs';

describe('the path rule of CI', () => {
  it('lets content alone pass on quick', () => {
    expect(needsFull('M\tdocs/operations/deployment.md\n')).toBe(false);
    expect(needsFull('A\tpublic/images/cover.webp\nM\tREADME.md\nD\tdocs/plan/old.md\n')).toBe(false);
  });

  it('asks for the full tier for anything else', () => {
    for (const diff of [
      '',
      'M\tsrc/app/layout.tsx',
      'M\tdocs/a.md\nM\tpackage.json',
      'D\tpublic/images/cover.png',
      'A\tpublic/images/x.svg',
      'A\tpublic/favicon.png',
      'A\tdocs/a.mdx',
      'M\tdata/common-passwords.md',
      'M\tsrc/README.md',
      'R100\tdocs/a.md\tdocs/b.md',
      'A\t"docs/\\303\\251.md"',
      'T\tdocs/a.md',
      'M docs/a.md',
    ]) {
      expect(needsFull(diff), diff).toBe(true);
    }
  });
});
