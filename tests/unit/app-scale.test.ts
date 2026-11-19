import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/app/scale.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();
const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');

describe('the app at 150% on a very wide screen', () => {
  it('sets --scale to 1.5 from 2200 CSS pixels, and nothing else', () => {
    expect(css).toBe('@media (min-width: 2200px) { :root { --scale: 1.5; } }');
  });

  it('is loaded by the root layout', () => {
    expect(layout).toContain("import './scale.css';");
  });
});
