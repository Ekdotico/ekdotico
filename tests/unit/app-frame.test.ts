import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/app/frame.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();
const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');

describe('the wide-screen frame', () => {
  it('caps the body at 1440px at the interface scale, above 1440 CSS pixels only', () => {
    expect(css).toBe(
      '@media (min-width: 1441px) { ' +
        'html { background: color-mix(in srgb, var(--bg-canvas) 97%, black); } ' +
        'body { max-width: calc(1440px * var(--scale)); min-height: 100dvh; margin-inline: auto; border-inline: 1px solid var(--rule); } ' +
        '}',
    );
  });

  it('is loaded by the root layout, after the scale it multiplies by', () => {
    expect(layout.indexOf("import './frame.css';")).toBeGreaterThan(layout.indexOf("import './scale.css';"));
  });
});
