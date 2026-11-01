// NFR-DP-03: docs/records/processors.md is a claim about what leaves. It is held to the code here: the release has
// no client of a processor it does not reach, no host of one, and the host of Brevo in the one file that sends (D206, D262).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const record = readFileSync('docs/records/processors.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

function sources(dir: string): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === 'src/generated' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [[path, readFileSync(path, 'utf8')] as [string, string]] : [];
  });
}

describe('the processor record', () => {
  it('names the three processors the release reaches and the two it does not', () => {
    const reached = record.split('## B.')[0]!;
    for (const name of ['DigitalOcean', 'Scaleway', 'Brevo'])
      expect(reached).toMatch(new RegExp(`^\\| ${name} +\\|`, 'm'));
    const not = record.split('## B.')[1]!.split('## C.')[0]!;
    for (const name of ['Anthropic', 'OpenAI']) expect(not).toMatch(new RegExp(`^\\| ${name} +\\|`, 'm'));
  });

  it('says of Brevo that the sender is built, what goes to it, that D262 settled its checks, and that the owner switches it on', () => {
    const brevo = /^\| Brevo .*$/m.exec(record)![0];
    expect(brevo).toMatch(/The sender is built/);
    expect(brevo).toMatch(/owner switches it on/);
    expect(brevo).toMatch(/D262/);
    expect(brevo).toMatch(/api\.brevo\.com\/v3\/smtp\/email/);
    expect(brevo).toMatch(/contactPixelTrackingConsent/);
    // Storage and transfers are those of §2.7, and nothing of Scaleway's is carried over.
    expect(brevo).toMatch(/OVH in France and Google Cloud in Belgium/);
    expect(brevo).toMatch(/EU-US Data Privacy Framework/);
    expect(brevo).not.toMatch(/Nothing is sent|not yet read|Not known/);
    expect(record).toMatch(/Q74/);
    expect(record).not.toMatch(/None of the checks of Q50 is made/);
  });
});

describe('the code against the record', () => {
  it('depends on no client of Anthropic, OpenAI, Brevo or Scaleway, nor of an identity or an email service', () => {
    const forbidden =
      /anthropic|openai|brevo|sendinblue|scaleway|resend|clerk|postmark|sendgrid|mailgun|nodemailer|@sentry|posthog|segment|mixpanel/i;
    expect(dependencies.filter((name) => forbidden.test(name))).toEqual([]);
  });

  it('names no host of a processor it does not reach in its code', () => {
    const hosts = /api\.anthropic\.com|api\.openai\.com|api\.scaleway\.com|scw\.cloud/i;
    const found = sources('src')
      .filter(([, text]) => hosts.test(text))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it('names the host of Brevo in exactly one file, the sender', () => {
    const found = sources('src')
      .filter(([, text]) => /brevo\.com|sendinblue/i.test(text))
      .map(([path]) => path);
    expect(found).toEqual([join('src', 'lib', 'email', 'index.ts')]);
  });

  it('sends email through Brevo or writes a file, and the choice is the one settings.ts takes', () => {
    const settings = readFileSync('src/lib/settings.ts', 'utf8');
    expect(settings).toMatch(/transport !== 'sink' && transport !== 'brevo'/);
    const email = readFileSync('src/lib/email/index.ts', 'utf8');
    expect(email).toMatch(/writeFile\(/);
    // One request, to one fixed address, that follows no redirect and gives up (NFR-SE-19: the key stays with Brevo).
    expect(email.match(/fetch\(/g)).toHaveLength(1);
    expect(email).toMatch(/const BREVO_URL = 'https:\/\/api\.brevo\.com\/v3\/smtp\/email'/);
    expect(email).toMatch(/redirect: 'error'/);
    expect(email).toMatch(/AbortSignal\.timeout\(BREVO_TIMEOUT_MS\)/);
    expect(email).not.toMatch(/https?\.request|net\.connect/);
  });

  // FR-ED-21: the email of a document is marked before it is handed over and never tried again. `handOver` tries
  // again, so none of these may call it: a timeout, where the outcome is unknown, would send a second email.
  it('keeps the email of a document, sent once, away from handOver', () => {
    const files = [
      'src/lib/documents/sharing.ts',
      'src/lib/documents/invitation-timers.ts',
      'src/lib/documents/ownership.ts',
      'src/lib/clearing/email.ts',
      'src/lib/account/transfer-email.ts',
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).toMatch(/from '\.\.\/email\/index\.ts'/);
      expect(text, file).not.toMatch(/from '[^']*hand-over[^']*'|\bhandOver\b/);
    }
  });

  // A run of the tests sends no real email, whatever a .env.local or the shell holds (register D262).
  it('pins the sink in every end-to-end environment that names a sink directory', () => {
    const files = ['playwright.config.ts', ...readdirSync('tests/e2e').map((name) => join('tests/e2e', name))]
      .filter((path) => /\.ts$/.test(path))
      .map((path) => [path, readFileSync(path, 'utf8')] as const);
    const named = files.filter(([, text]) => /EMAIL_SINK_DIRECTORY:/.test(text)).map(([path]) => path);
    expect(named).toEqual(
      expect.arrayContaining([
        'playwright.config.ts',
        join('tests/e2e', 'fault-page.spec.ts'),
        join('tests/e2e', 'sharing.ts'),
        join('tests/e2e', 'smoke.spec.ts'),
      ]),
    );
    for (const [path, text] of files.filter(([path]) => named.includes(path))) {
      expect(text, path).toMatch(/EMAIL_TRANSPORT: 'sink'/);
    }
    // And none sets Brevo, or the key.
    for (const [path, text] of files)
      expect(text, path).not.toMatch(/BREVO_API_KEY|EMAIL_TRANSPORT: 'brevo'/);
  });

  it('reads the key of Brevo in settings.ts alone', () => {
    const found = sources('src')
      .filter(([, text]) => /BREVO_API_KEY/.test(text))
      .map(([path]) => path);
    expect(found).toEqual([join('src', 'lib', 'settings.ts')]);
  });

  it('sends nothing to Praktico', () => {
    const found = sources('src')
      .filter(([, text]) => /internal\.ekdoti\.co/.test(text))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });
});
