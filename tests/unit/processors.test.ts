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
