// Two checks on the direct dependencies of package.json, run in CI.
//
// NFR-IC-08: every dependency is pinned to an exact version.
// NFR-IC-12: every direct dependency carries a licence that needs no review, or
// is listed below with the review that admitted it.
import { readFileSync } from 'node:fs';

const FREE = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'CC0-1.0']);
// Reviewed: package name -> the licence that was reviewed and where the review is recorded.
const REVIEWED = {
  '@ekdotico/domico': { license: 'AGPL-3.0-only', record: 'Build phases, entry criteria (register D19)' },
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const direct = { ...pkg.dependencies, ...pkg.devDependencies };
const faults = [];

for (const [name, version] of Object.entries(direct)) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    faults.push(`${name}: "${version}" is not an exact version (NFR-IC-08)`);
  }
  let license;
  try {
    license = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).license;
  } catch {
    faults.push(`${name}: not installed, so its licence cannot be read`);
    continue;
  }
  const reviewed = REVIEWED[name];
  if (!FREE.has(license) && reviewed?.license !== license) {
    faults.push(
      `${name}: licence "${license}" needs a review recorded in scripts/check-deps.mjs (NFR-IC-12)`,
    );
  }
}

if (faults.length) {
  console.error(faults.join('\n'));
  process.exit(1);
}
console.log(
  `${Object.keys(direct).length} direct dependencies: every one pinned exactly, every licence admitted.`,
);
