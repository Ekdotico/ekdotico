// Runs ON THE DEPLOYER'S MACHINE (docs/operations/deployment.md, "Deploying a release"). GitHub Actions never
// connects to the server: this downloads the release that the workflow `release` built, checks it, sends it over
// the deployer's own ssh, and drives scripts/deploy/server.mjs there. Plain Node; needs `gh`, `ssh`, `scp`, `tar`.
//
//   node scripts/deploy/deploy.mjs keygen   --out <private-key-file>
//   node scripts/deploy/deploy.mjs deploy   --sha <sha> --run <run-id> --key <private-key-file> [--migrate --env-file <file on the server>]
//   node scripts/deploy/deploy.mjs rollback
//   node scripts/deploy/deploy.mjs status
//
// The server comes from the deployer's environment, never from a file in this repository: DEPLOY_HOST (an ssh
// host or an alias of ~/.ssh/config), DEPLOY_USER (optional where the alias names one), DEPLOY_BASE (default
// /srv/ekdotico), DEPLOY_SSH_PORT (optional).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSha, keyPair, parseArgs, unseal, verifyChecksum } from './lib.mjs';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

function server(env = process.env) {
  if (!env.DEPLOY_HOST)
    throw new Error('set DEPLOY_HOST (and DEPLOY_USER where the host is not an ssh alias that names one)');
  const target = env.DEPLOY_USER ? `${env.DEPLOY_USER}@${env.DEPLOY_HOST}` : env.DEPLOY_HOST;
  const port = env.DEPLOY_SSH_PORT ? ['-P', env.DEPLOY_SSH_PORT] : [];
  const base = env.DEPLOY_BASE ?? '/srv/ekdotico';
  if (!base.startsWith('/') || /[^A-Za-z0-9/._-]/.test(base))
    throw new Error(`DEPLOY_BASE must be an absolute plain path: ${base}`);
  return {
    base,
    // Every argument is checked above or is a sha, a number, or a path this script builds: none is quoted for the shell.
    ssh: (...words) => run('ssh', [...(port.length ? ['-p', port[1]] : []), target, ...words]),
    scp: (files, dir) => run('scp', [...port, ...files, `${target}:${dir}/`]),
    script: (command, ...rest) => ['node', `${base}/bin/server.mjs`, command, '--base', base, ...rest],
  };
}

async function deploy(args) {
  const sha = checkSha(args.sha);
  if (!/^\d+$/.test(args.run))
    throw new Error('--run is the numeric id of the run of the workflow `release`');
  if (args.migrate && !args['env-file'])
    throw new Error('--migrate needs --env-file, the file on the server that sets MIGRATE_DATABASE_URL');
  if (args['env-file'] && !/^\/[A-Za-z0-9/._-]+$/.test(args['env-file']))
    throw new Error('--env-file must be an absolute plain path');
  const s = server();
  const dir = mkdtempSync(join(tmpdir(), 'ekdotico-release-'));
  run('gh', [
    'run',
    'download',
    args.run,
    '--repo',
    'Ekdotico/ekdotico',
    '--name',
    `release-${sha}`,
    '--dir',
    dir,
  ]);

  const manifest = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  if (manifest.sha !== sha) throw new Error(`run ${args.run} built ${manifest.sha}, not ${sha}`);
  if (manifest.deployable !== true) throw new Error(`run ${args.run} is not deployable: ${manifest.reason}`);
  const tarball = join(dir, 'release.tgz');
  writeFileSync(tarball, unseal(readFileSync(join(dir, 'release.sealed')), readFileSync(args.key, 'utf8')));
  await verifyChecksum(tarball, manifest.sha256);
  console.log(`release ${sha} opened and checked (sha-256 ${manifest.sha256})`);

  // The server script of the release itself, so that the steps are those of the commit being deployed.
  run('tar', ['-xzf', tarball, '-C', dir, 'scripts/deploy/server.mjs', 'scripts/deploy/lib.mjs']);
  const incoming = `${s.base}/incoming/${sha}`;
  s.ssh('mkdir', '-p', '-m', '700', incoming);
  s.scp([tarball, join(dir, 'scripts/deploy/server.mjs'), join(dir, 'scripts/deploy/lib.mjs')], incoming);
  const at = (command, ...rest) =>
    s.ssh('node', `${incoming}/server.mjs`, command, '--base', s.base, ...rest);
  at('stage', '--sha', sha, '--tarball', `${incoming}/release.tgz`, '--sha256', manifest.sha256);
  if (args.migrate) at('migrate', '--sha', sha, '--env-file', args['env-file']);
  at('switch', '--sha', sha); // restarts both services, checks them, and switches back by itself on failure
  at('prune');
  // Kept outside the releases, so that `rollback` and `status` work whichever release is current, the layout's
  // first one (`app`, which has no copy) included.
  s.ssh('mkdir', '-p', `${s.base}/bin`);
  s.ssh('cp', `${incoming}/server.mjs`, `${incoming}/lib.mjs`, `${s.base}/bin/`);
  s.ssh('rm', '-rf', incoming);
}

const [command, ...argv] = process.argv.slice(2);
try {
  if (command === 'keygen') {
    const { out } = parseArgs(argv, { required: ['out'] });
    const { publicKey, privateKey } = keyPair();
    writeFileSync(out, privateKey, { mode: 0o600, flag: 'wx' });
    console.log(
      `private key written to ${out} (keep it off the server and out of the repository). Public key:\n${publicKey}`,
    );
  } else if (command === 'deploy') {
    await deploy(
      parseArgs(argv, { required: ['sha', 'run', 'key'], flags: ['migrate'], optional: ['env-file'] }),
    );
  } else if (command === 'rollback' || command === 'status') {
    parseArgs(argv, {});
    const s = server();
    s.ssh(...s.script(command));
  } else {
    throw new Error('usage: deploy.mjs keygen|deploy|rollback|status (see the head of this file)');
  }
} catch (error) {
  console.error(`deploy.mjs: ${error.message}`);
  process.exit(1);
}
