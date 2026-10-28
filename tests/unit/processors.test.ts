// NFR-DP-03: docs/records/processors.md is a claim about what leaves. It is held to the code here: the release has
// no client of a processor it does not reach, no host of one, and a sender that writes a file (D206, Q50).
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

  it('says of Brevo that nothing is sent and that none of the checks of Q50 is made', () => {
    const brevo = /^\| Brevo .*$/m.exec(record)![0];
    expect(brevo).toMatch(/Nothing is sent/);
    expect(brevo).toMatch(/Q50/);
    expect(brevo).toMatch(/not yet read/);
    expect(record).toMatch(/None of the checks of Q50 is made/);
  });
});

describe('the code against the record', () => {
  it('depends on no client of Anthropic, OpenAI, Brevo or Scaleway, nor of an identity or an email service', () => {
    const forbidden =
      /anthropic|openai|brevo|sendinblue|scaleway|resend|clerk|postmark|sendgrid|mailgun|nodemailer|@sentry|posthog|segment|mixpanel/i;
    expect(dependencies.filter((name) => forbidden.test(name))).toEqual([]);
  });

  it('names no host of a processor it does not reach, or of Brevo, in its code', () => {
    const hosts =
      /api\.brevo\.com|sendinblue|api\.anthropic\.com|api\.openai\.com|api\.scaleway\.com|scw\.cloud/i;
    const found = sources('src')
      .filter(([, text]) => hosts.test(text))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it('sends no email: the sink is the one transport settings.ts takes', () => {
    const settings = readFileSync('src/lib/settings.ts', 'utf8');
    expect(settings).toMatch(/env\.EMAIL_TRANSPORT !== 'sink'/);
    const email = readFileSync('src/lib/email/index.ts', 'utf8');
    expect(email).toMatch(/writeFile\(/);
    expect(email).not.toMatch(/fetch\(|https?\.request|net\.connect/);
  });

  it('sends nothing to Praktico', () => {
    const found = sources('src')
      .filter(([, text]) => /internal\.ekdoti\.co/.test(text))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });
});
