// The path rule of CI (.github/workflows/ci.yml, job `changes`): whether a change needs the full tier
// (integration and end-to-end tests) or is gated by `quick` alone.
//
// Input: the output of `git diff --raw --no-renames <base> <head>`, one line a file.
// A change is content-only when it is not empty and EVERY line matches an entry below. Anything else, an
// unknown status, a file that is not a regular one, a quoted (unusual) path, or an empty diff, needs the full tier: the rule fails closed.
//
// Usage: node scripts/ci/scope.mjs <file>   prints `full=true` or `full=false`.

import { readFileSync } from 'node:fs';

/** Each entry: the statuses it allows (A added, M modified, D deleted) and the paths it covers. */
export const CONTENT_ONLY = [
  // Documentation outside the application's source. Nothing under src/, scripts/ or tests/integration
  // and tests/e2e reads it; the unit tests that do read it run in `quick`, as does the format check.
  { statuses: 'AMD', path: /^docs\/[^"]*\.md$/ },
  // The documents at the root of the repository, read by nothing that runs.
  { statuses: 'AMD', path: /^(README|CHANGELOG|CONTRIBUTING|SECURITY|TRADEMARKS|CLAUDE)\.md$/ },
  // A raster image added or replaced under public/images/, served as a static file. No route of the
  // application is under /images. Not deleted: a page may name it. Not SVG: it can hold a script.
  { statuses: 'AM', path: /^public\/images\/[^"]+\.(png|jpe?g|webp|avif|gif)$/ },
];

// A line of `git diff --raw --no-renames`: ":<old mode> <new mode> <old sha> <new sha> <status>\t<path>".
const RAW = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\t([^\t]+)$/;

/** @param {string} text */
export function needsFull(text) {
  const lines = text.split('\n').filter((line) => line !== '');
  if (lines.length === 0) return true;
  return !lines.every((line) => {
    const match = RAW.exec(line);
    if (!match) return false;
    const [, oldMode, newMode, status, path] = match;
    // A regular file and nothing else: a symbolic link (120000), a submodule (160000), an executable
    // (100755) or a change of type needs the full tier.
    const regular = status === 'D' ? oldMode === '100644' : newMode === '100644';
    if (!regular || (status === 'M' && oldMode !== '100644')) return false;
    return CONTENT_ONLY.some((entry) => entry.statuses.includes(status) && entry.path.test(path));
  });
}

if (import.meta.main) {
  console.log(`full=${needsFull(readFileSync(process.argv[2] ?? '', 'utf8'))}`);
}
