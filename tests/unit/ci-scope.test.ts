import { describe, expect, it } from 'vitest';
import { needsFull } from '../../scripts/ci/scope.mjs';

/** A line of `git diff --raw --no-renames`. */
const raw = (oldMode: string, newMode: string, status: string, path: string) =>
  `:${oldMode} ${newMode} 1111111 2222222 ${status}\t${path}`;
const added = (path: string, mode = '100644') => raw('000000', mode, 'A', path);
const changed = (path: string) => raw('100644', '100644', 'M', path);
const deleted = (path: string, mode = '100644') => raw(mode, '000000', 'D', path);

describe('the path rule of CI', () => {
  it('lets content alone pass on quick', () => {
    expect(needsFull(changed('docs/operations/deployment.md') + '\n')).toBe(false);
    expect(
      needsFull(
        [added('public/images/cover.webp'), changed('README.md'), deleted('docs/plan/old.md')].join('\n'),
      ),
    ).toBe(false);
  });

  it('asks for the full tier for anything else', () => {
    for (const diff of [
      '',
      changed('src/app/layout.tsx'),
      [changed('docs/a.md'), changed('package.json')].join('\n'),
      deleted('public/images/cover.png'),
      added('public/images/x.svg'),
      added('public/favicon.png'),
      added('docs/a.mdx'),
      changed('data/common-passwords.md'),
      changed('src/README.md'),
      'R100\tdocs/a.md\tdocs/b.md',
      ':100644 100644 1111111 2222222 R100\tdocs/a.md\tdocs/b.md',
      added('"docs/\\303\\251.md"'),
      raw('100644', '100644', 'T', 'docs/a.md'),
      'M\tdocs/a.md',
      // Not a regular file: a symbolic link, a submodule, an executable, a change of type.
      added('public/images/x.png', '120000'),
      added('docs/a.md', '160000'),
      added('docs/a.md', '100755'),
      raw('100644', '100755', 'M', 'docs/a.md'),
      raw('120000', '100644', 'M', 'public/images/x.png'),
      deleted('docs/a.md', '120000'),
    ]) {
      expect(needsFull(diff), diff).toBe(true);
    }
  });
});
