// NFR-SE-06, A10: the page of a fault shows the one fixed statement, which is
// the proxy's for a 500, and nothing of the fault but its reference (the
// owner's decision of 12 October 2026). The texts are written out here and
// not taken from the code under test.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PageFault, { faultReference } from '../../src/app/error.tsx';

const STATEMENT =
  'The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes.';
const QUOTE = 'Quote this reference when you report the fault.';

/** An error as Next.js hands it to the page: the error of a server component carries a digest. */
const fault = (digest?: unknown) =>
  Object.assign(new Error('person@example.com could not be read from "User"'), { digest });
const shown = (error?: unknown) => renderToStaticMarkup(createElement(PageFault, { error }));
/** The text of the page, without its markup. */
const words = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('the page of a fault', () => {
  it('shows the fixed statement, announced, under one heading of the page', () => {
    for (const markup of [shown(), shown(fault()), shown(fault('2788174031'))]) {
      expect(markup).toContain(STATEMENT);
      expect(markup).toContain('role="alert"');
      expect(markup.match(/<h1[ >]/g)).toHaveLength(1);
      expect(markup).toContain('<main');
    }
  });

  it('shows the reference of a fault of the server after the statement, as text, inside what is announced', () => {
    const markup = shown(fault('2788174031'));
    expect(words(markup)).toContain(`${STATEMENT} ${QUOTE} Reference: 2788174031 `);
    // Inside the statement that a screen reader is told of.
    const alert = markup.slice(markup.indexOf('role="alert"'), markup.indexOf('ekd-cluster'));
    expect(alert).toContain('<p>Reference: 2788174031</p>');
    // Text and nothing else: no link, nothing to press, nothing hidden or kept from being selected.
    expect(alert).not.toMatch(/<button|<a |<input/);
    expect(alert).not.toMatch(/style=|aria-hidden/);
  });

  it('shows nothing of the error but the reference: no message, no name, no stack', () => {
    const error = fault('2788174031');
    const markup = shown(error);
    expect(markup).not.toContain('person@example.com');
    expect(markup).not.toContain('User');
    expect(markup).not.toContain('error-page.test');
    expect(words(markup)).not.toMatch(/\bError\b/);
    expect(error.stack).toContain('error-page.test');
  });

  it('shows no reference where there is none: a fault of the browser has no digest', () => {
    for (const error of [undefined, null, fault(), new Error('x'), 'a string', {}]) {
      const markup = shown(error);
      expect(markup).not.toContain('Reference');
      expect(markup).not.toContain(QUOTE);
      expect(markup).not.toMatch(/<input/);
    }
  });

  it('offers to try again and to go to the documents, after the statement, and titles the tab', () => {
    const markup = shown(fault('2788174031'));
    expect(markup).toContain('<title>Page not shown – Ekdotico</title>');
    expect(markup).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(markup).toMatch(/<a [^>]*href="\/"[^>]*>\s*Documents\s*<\/a>/);
    // The statement itself says "Try again in a few minutes", so find the button by its tag.
    const button = markup.indexOf('>Try again</button>');
    expect(button).toBeGreaterThan(markup.indexOf('Reference: 2788174031'));
    expect(markup.indexOf('>Documents</a>')).toBeGreaterThan(button);
  });

  it.each([
    'person@example.com',
    'NEXT_REDIRECT;replace;/sign-in;307;',
    'Error: connect ECONNREFUSED 192.0.2.7:5432',
    '12345678901',
    '-1',
    '12 34',
    '1e9',
    '0x1f',
    '',
    ' 2788174031',
    '2788174031\n',
    2788174031,
    { toString: () => '2788174031' },
    ['2788174031'],
  ])('shows no digest that is not a number of ten digits at most: %j', (digest) => {
    expect(faultReference(fault(digest))).toBeNull();
    expect(shown(fault(digest))).not.toContain('Reference');
  });

  it.each(['0', '7', '2788174031', '4294967295'])('takes the digest %s', (digest) => {
    expect(faultReference(fault(digest))).toBe(digest);
  });
});
