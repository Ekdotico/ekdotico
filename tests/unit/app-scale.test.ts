import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/app/scale.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();
const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');

describe('the app grows smoothly to 150% on a very wide screen', () => {
  it('names the width it starts from, once, and the width it ends at', () => {
    expect(css).toContain(':root { --scale-start: 1440px; --scale-end: 2560px; }');
    expect(css.match(/1440px/g)).toHaveLength(1);
  });

  it('sets --scale between 1 and 1.5, from the viewport width, and only where the browser can compute it', () => {
    expect(css).toContain('@supports (width: calc(1px * tan(atan2(1px, 1px))))');
    expect(css).toContain(
      '--scale: clamp( 1, calc(1 + 0.5 * tan(atan2(100vw - var(--scale-start), var(--scale-end) - var(--scale-start)))), 1.5 );',
    );
  });

  it('is never a size of its own: no zoom, no transform, no font-size, no bare vw size', () => {
    expect(css).not.toMatch(/zoom|transform|font-size/);
    expect(css.match(/100vw/g)).toHaveLength(1);
  });

  it('is loaded by the root layout', () => {
    expect(layout).toContain("import './scale.css';");
  });
});
