import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FRAME = "import '@ekdotico/domico/styles/frame.css';";
const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');

describe('the wide-screen frame', () => {
  it('comes from the design package, after the scale it multiplies by', () => {
    expect(layout).toContain(FRAME);
    expect(layout.indexOf(FRAME)).toBeGreaterThan(layout.indexOf("import './scale.css';"));
  });

  it('has no copy of its own in the application', () => {
    expect(existsSync(new URL('../../src/app/frame.css', import.meta.url))).toBe(false);
    expect(layout).not.toContain("import './frame.css';");
  });
});
