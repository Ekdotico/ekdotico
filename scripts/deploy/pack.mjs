// Runs IN ACTIONS, in the built checkout (.github/workflows/release.yml). Writes RELEASE.json into the tree, packs
// the tree into release.tgz, and writes into <out>: release.json (the manifest, with the tarball's sha-256), and
// either release.sealed (deployable: sealed to RELEASE_PUBLIC_KEY) or release.tgz itself (not deployable).
//
//   node scripts/deploy/pack.mjs --sha <sha> --out <dir> --run <run-id> (--deployable | --reason <why not>)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { checkSha, parseArgs, seal, sha256File } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  required: ['sha', 'out', 'run'],
  flags: ['deployable'],
  optional: ['reason'],
});
const sha = checkSha(args.sha);
if (!isAbsolute(args.out))
  throw new Error('--out is an absolute directory outside the checkout, which is packed whole');
if (!args.deployable && !args.reason) throw new Error('a build that is not deployable says why (--reason)');
const key = process.env.RELEASE_PUBLIC_KEY;
if (args.deployable && !key?.includes('BEGIN PUBLIC KEY')) {
  throw new Error(
    'RELEASE_PUBLIC_KEY (a repository variable) holds no public key: see docs/operations/deployment.md',
  );
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== sha) throw new Error(`the checkout is at ${head}, not ${sha}`);

const manifest = {
  sha,
  deployable: Boolean(args.deployable),
  ...(args.deployable ? {} : { reason: args.reason }),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  run: args.run,
  builtAt: new Date().toISOString(),
};
writeFileSync('RELEASE.json', `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(args.out, { recursive: true });
const tarball = join(args.out, 'release.tgz');
// The whole built tree: the web application runs `next start` from it, and the collaboration server runs its
// TypeScript sources with Node.js directly, so both need src/ and node_modules/ (with the generated Prisma client
// under src/generated/ and the Prisma CLI for `migrate deploy`). Excluded: git, and the caches of the build.
execFileSync(
  'tar',
  ['--exclude=./.git', '--exclude=./.next/cache', '--exclude=./node_modules/.cache', '-czf', tarball, '.'],
  {
    stdio: 'inherit',
  },
);
const sha256 = await sha256File(tarball);
const size = statSync(tarball).size;

// release.tgz stays in <out> for the start test of the workflow; for a deployable build only release.sealed and
// release.json are uploaded.
if (args.deployable) writeFileSync(join(args.out, 'release.sealed'), seal(readFileSync(tarball), key));
writeFileSync(join(args.out, 'release.json'), `${JSON.stringify({ ...manifest, sha256, size }, null, 2)}\n`);
console.log(
  `packed ${sha}: ${(size / 1024 / 1024).toFixed(1)} MB, sha-256 ${sha256}, deployable: ${manifest.deployable}`,
);
