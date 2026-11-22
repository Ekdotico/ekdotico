// The privacy notice at `/privacy` (FR-AU-72; owner's answers of 21 November 2026: fw-privacy-page,
// fw-privacy-text, fw-privacy-hosting, fw-privacy-gaps). The approved wording is pinned whole: a word added,
// dropped or changed fails here. The contact address is the environment's (`CONTACT_ADDRESS`) and is a made-up one
// in these tests; no real address is in this repository.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const held = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock('../../src/lib/settings.ts', () => ({ settings: () => ({ contactAddress: held.address }) }));

const { default: Privacy } = await import('../../src/app/privacy/page.tsx');

const ADDRESS = 'team@example.test';

// The approved notice, from "Privacy notice" to the section "How to reach the team", verbatim. The contact address
// is written [contact address], as in the approval, and each section is its name, a full stop and a space, and its
// text.
const APPROVED = `Privacy notice

Who this is for. Ekdotico is in Closed α, an early test release. This notice is for the people who have an account in it.

What the application keeps about your account. Your name, your email address and, if you added one, your avatar. A hash of your password, and, if you turned on two-factor authentication, its secret and its recovery codes. Each session you have open, with the browser and the network address it began from. The time at which you acknowledged the Closed α notice, and the version you acknowledged. The documents you write, their images, and the invitations and notifications that concern you. A record of security events, with your account identifier and no name or address, for 30 days. All of this is held in the application's own database in the Netherlands. The application has no identity provider outside itself.

What happens when you send feedback. Sending feedback is your choice, and there is no box to tick. Your message goes to the Ekdotico team with the kind of feedback you chose, the kind of page you were on, the Ekdotico version, your browser and its window size, and your account identifier. The content of your documents is not sent. Whatever you type in the message is sent as you typed it, so leave out anything you do not want the team to read. The application does not keep a copy of your feedback. The application sends it to Praktico, the team's internal tool, which stores it in a table of its own and shows it to the team. Feedback is kept until 12 months after the last Closed α release. The team can delete one submission on request.

Who handles your data. DigitalOcean hosts the application and its storage in the Netherlands, and hosts Praktico in Frankfurt. Brevo sends the email the application sends you. Scaleway holds an encrypted copy of the backups, which it cannot read. The browser makes no request to any other service for the feedback widget.

Backups. A copy of what the database holds is kept in backups for a recovery window after you delete it, so deleted data can still be restored for that window.

Deleting your account. You can delete your account from your account settings. You are asked for your password again, and for a code if you use two-factor authentication. You cannot delete an account that owns a document: you first transfer the ownership of each document, or clear the documents, which deletes them for good. When your account is deleted, your name, email address and avatar are cleared, your password and your sessions are deleted, and nothing from which you could be found is put in their place. What you wrote in other people's documents stays, shown as "Deleted account". Your feedback stays, with your account identifier removed from it. Deleting an account in Closed α is not by itself an answer to a request to erase your data.

How to reach the team. [contact address]`;

const decode = (text: string) =>
  text.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const strip = (html: string) => decode(html.replace(/<[^>]+>/g, ''));
const render = () => renderToStaticMarkup(createElement(Privacy));
const all = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gs'))].map(([, inner]) => strip(inner!));

/** The notice as the page shows it, in the form of the approval: the title, then each section as name, stop and text. */
function shown(html: string): string {
  const [title] = all(html, 'h1');
  const names = all(html, 'h2');
  const texts = all(html, 'p');
  return [title, ...names.map((name, index) => `${name}. ${texts[index]}`)].join('\n\n');
}

beforeEach(() => {
  held.address = ADDRESS;
});

describe('the privacy notice', () => {
  it('is the approved text, whole, with the environment’s address in the last section', () => {
    expect(shown(render())).toBe(APPROVED.replace('[contact address]', ADDRESS));
  });

  it('has the heading “Privacy notice” and the sections as headings, in order', () => {
    const html = render();
    expect(all(html, 'h1')).toEqual(['Privacy notice']);
    expect(all(html, 'h2')).toEqual([
      'Who this is for',
      'What the application keeps about your account',
      'What happens when you send feedback',
      'Who handles your data',
      'Backups',
      'Deleting your account',
      'How to reach the team',
    ]);
  });

  it('has nothing above the heading, no date and no version line', () => {
    const html = render();
    // The first thing with text in the page is the heading.
    expect(strip(html.slice(html.indexOf('<main')))).toMatch(/^Privacy notice/);
    expect(html).not.toContain('<time');
    expect(strip(html)).not.toMatch(/\b(updated|last changed|version \d)/i);
  });

  it('sets the α in the sans and everything else as written, since the serif has no Greek', () => {
    const html = render();
    const alphas = strip(html).split('α').length - 1;
    expect(alphas).toBe(4);
    expect([...html.matchAll(/<span class="[^"]*greek[^"]*">α<\/span>/g)]).toHaveLength(alphas);
    // Every α is inside such a span.
    expect(html.replace(/<span class="[^"]*greek[^"]*">α<\/span>/g, '')).not.toContain('α');
  });

  it('gives the contact address as a link, and nothing else in that section', () => {
    const html = render();
    expect(html).toContain(`<a href="mailto:${ADDRESS}">${ADDRESS}</a>`);
  });

  it('cannot add a field to the mail through the local part of the address (review, low)', () => {
    held.address = 'x?cc=y&bcc=z#h@team.example';
    const html = render();
    expect(html).toContain('href="mailto:x%3Fcc%3Dy%26bcc%3Dz%23h@team.example"');
    expect(html).not.toContain('mailto:x?');
  });

  it('leaves the last section out where the environment has no address, and shows no placeholder', () => {
    held.address = undefined;
    const html = render();
    expect(all(html, 'h2')).not.toContain('How to reach the team');
    expect(strip(html)).not.toContain('[contact address]');
    expect(strip(html)).not.toContain('contact address');
    expect(html).not.toContain('mailto:');
    // The rest is the approved text, in the form it has.
    expect(shown(html)).toBe(APPROVED.slice(0, APPROVED.indexOf('\n\nHow to reach the team.')));
  });

  it('is the same page each time, for anyone', () => {
    expect(render()).toBe(render());
  });
});

describe('what the page reads', () => {
  const source = readFileSync('src/app/privacy/page.tsx', 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('takes no request, no session, no cookie, no header and no query', () => {
    expect(code).not.toMatch(/\b(cookies|headers|searchParams|params|validateSession|session|request)\b/i);
    expect(code).not.toMatch(/export default function Privacy\(\s*[^)\s]/);
  });

  it('uses the package’s components and borrows no class of the package', () => {
    expect(code).toContain("from '@ekdotico/domico/components'");
    expect(code).not.toMatch(/ekd-/);
  });

  it('holds no address, and the text module holds none either', () => {
    for (const file of ['src/app/privacy/page.tsx', 'src/lib/privacy-notice.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });
});
