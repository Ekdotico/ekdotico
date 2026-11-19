// UI audit F04, F21, F15: the words the owner approved on 17 November 2026 (ui-t1-sharing, ui-t2-nav),
// written out here and not taken from the code under test, and the appearance control in the header.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let current = '/';
vi.mock('next/navigation', () => ({ usePathname: () => current, useRouter: () => ({ refresh: () => {} }) }));

const { SharingHead } = await import('../../src/app/(app)/documents/[id]/sharing/sharing-head.tsx');
const { ShellHeader } = await import('../../src/app/(app)/shell-header.tsx');

const text = (markup: string) => markup.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '|');

describe('the top of the Sharing page', () => {
  const markup = renderToStaticMarkup(
    createElement(SharingHead, { documentId: 'abc', title: 'Field notes <b>' }),
  );

  it('says which document it is for, with the title as text', () => {
    expect(text(markup)).toContain('|Document: |Field notes &lt;b&gt;|');
    expect(markup).not.toContain('<b>');
  });

  it('leads back to the document', () => {
    expect(markup).toContain('<a href="/documents/abc">Back to document</a>');
  });
});

describe('the header', () => {
  const shown = (path: string) => {
    current = path;
    return renderToStaticMarkup(createElement(ShellHeader));
  };

  it('holds its links in a landmark named "Main", with a link "Documents" to the list', () => {
    const nav = /<nav aria-label="Main">(.*?)<\/nav>/s.exec(shown('/'))?.[1] ?? '';
    expect(nav).toMatch(/<a [^>]*href="\/"[^>]*>Documents<\/a>/);
    expect(nav).toContain('Account settings');
  });

  it('marks the link of the current page, and no other', () => {
    expect(shown('/').match(/aria-current="page"/g)).toHaveLength(1);
    expect(shown('/')).toMatch(/aria-current="page"[^>]*>Documents</);
    expect(shown('/settings')).toMatch(/aria-current="page"[^>]*>Account settings</);
    expect(shown('/documents/abc/sharing')).not.toContain('aria-current');
  });

  it('carries the design system\'s appearance control, named "Appearance"', () => {
    const markup = shown('/');
    expect(markup.match(/<button[^>]*aria-expanded="false"[^>]*>/g)).toHaveLength(1);
    expect(markup).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Appearance|<button[^>]*aria-label="Appearance"/s,
    );
  });
});
