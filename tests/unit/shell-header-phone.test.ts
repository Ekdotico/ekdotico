import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tsx = readFileSync('src/app/(app)/shell-header.tsx', 'utf8');
const css = readFileSync('src/app/pages.module.css', 'utf8');

describe('the header (modernisation A3)', () => {
  it('pins the trigger word whole, in one constant (approved by the owner on 23 November 2026)', () => {
    expect(tsx).not.toContain('PROPOSED');
    expect(tsx).toContain("export const MENU_TEXT = 'Menu';");
    expect(tsx.match(/triggerLabel=\{MENU_TEXT\}/g)).toHaveLength(1);
  });

  it('opens the package drawer, closed by the route, with no class borrowed', () => {
    expect(tsx).toMatch(/<NavDrawer\s[^>]*closeKey=\{pathname\}/);
    expect(tsx).not.toMatch(/mobile-nav|ekd-/);
  });

  it('keeps one appearance control', () => {
    expect(tsx.match(/<AppearanceMenu/g)).toHaveLength(1);
  });

  it('caps the row at the page width, centred, one bar high, by tokens', () => {
    const row = /\.headerRow \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(row).toContain('max-inline-size: var(--page-w)');
    expect(row).toContain('margin-inline: auto');
    expect(row).toContain('min-block-size: var(--topbar-h)');
    expect(row).not.toContain('flex-wrap');
  });

  it('shows the inline links from 921px, where the package hides its trigger above 920px', () => {
    expect(css).toMatch(/@media \(min-width: 921px\) \{\s*\.inlineNav \{\s*display: block;/);
  });
});
