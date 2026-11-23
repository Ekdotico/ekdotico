import { describe, expect, it } from 'vitest';
import { toolbarSide } from '../../src/lib/editor/toolbar-side.ts';

describe('toolbarSide', () => {
  it('stays above where the room holds the toolbar and its gap', () => {
    expect(toolbarSide(200, 42, 8)).toBe('above');
    expect(toolbarSide(50, 42, 8)).toBe('above');
  });

  it('goes below when the room is a pixel short', () => {
    expect(toolbarSide(49, 42, 8)).toBe('below');
    expect(toolbarSide(16, 42, 8)).toBe('below');
    expect(toolbarSide(0, 42, 8)).toBe('below');
  });

  it('judges a taller toolbar (wrapped on a phone) by its own height', () => {
    expect(toolbarSide(80, 42, 8)).toBe('above');
    expect(toolbarSide(80, 90, 8)).toBe('below');
  });
});
