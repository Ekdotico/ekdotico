// NFR-SE-06, A10: the page of a fault shows the one fixed statement, which is
// the proxy's for a 500, and nothing of the fault. Written out here and not
// taken from the code under test.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PageFault from '../../src/app/error.tsx';

const STATEMENT =
  'The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes.';

describe('the page of a fault', () => {
  const markup = renderToStaticMarkup(createElement(PageFault));

  it('shows the fixed statement, announced, under one heading of the page', () => {
    expect(markup).toContain(STATEMENT);
    expect(markup).toContain('role="alert"');
    expect(markup.match(/<h1[ >]/g)).toHaveLength(1);
    expect(markup).toContain('<main');
  });

  it('takes nothing of the error, so shows nothing of it, and offers nothing to press', () => {
    // Next.js hands the component the error and a way to try again: it reads neither.
    expect(PageFault).toHaveLength(0);
    expect(markup).not.toMatch(/<button|<a /);
  });
});
