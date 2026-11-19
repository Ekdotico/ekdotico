// The arithmetic of the harness of procedure 1 (scripts/measure/), and the way it writes the reference document
// into a document: the editor must read back what the fixture says.
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { closeSchema, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { fillFragment, FRAGMENT, tailLength } from '../../scripts/measure/harness.ts';
import { DEFAULT_LOADS, DEFAULT_RATE, LCP_BUDGET_MS, pageLoadReport } from '../../scripts/measure/plan.ts';
import { percentile, summary } from '../../scripts/measure/stats.ts';
import { referenceDocument } from '../fixtures/reference-document.ts';

describe('percentile (nearest rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, at) => at + 1);

  it('is a value that was measured: the 50th of 1..100 is 50 and the 99th is 99', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it('does not depend on the order, and does not interpolate', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([10, 20], 99)).toBe(20);
  });

  it('puts the 99th of 101 values at the 100th, so one slow change in a hundred is not hidden', () => {
    const slow = [...Array.from({ length: 100 }, () => 5), 500];
    expect(percentile(slow, 99)).toBe(5);
    expect(percentile([...slow, 600], 99)).toBe(500);
  });

  it('refuses nothing to measure, and a percentile out of range', () => {
    expect(() => percentile([], 50)).toThrow(/No values/);
    expect(() => percentile([1], 0)).toThrow(/above 0/);
    expect(() => percentile([1], 101)).toThrow(/above 0/);
  });

  it('summarises with the count, the two figures and the largest', () => {
    expect(summary([1, 2, 3, 4])).toEqual({ n: 4, p50: 2, p99: 4, max: 4 });
  });
});

describe('the fixed figures of procedure 1', () => {
  it('types at four keystrokes a second (register D295) and loads each page twenty times unless told', () => {
    expect(DEFAULT_RATE).toBe(4);
    expect(DEFAULT_LOADS).toBe(20);
    expect(LCP_BUDGET_MS).toBe(2500);
  });
});

describe('pageLoadReport', () => {
  it('takes the 75th percentile, nearest rank: 8 of 10 loads under the budget is the third quartile', () => {
    const times = [900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 3000, 4000];
    // ceil(0.75 * 10) = the 8th smallest.
    expect(pageLoadReport(times)).toEqual({ loads: 10, p75: 1600, budgetMs: 2500, met: true });
  });

  it('is not met when the P75 is at the budget or above it, however good the median is', () => {
    expect(pageLoadReport([100, 100, 100, 2500]).met).toBe(true); // the 3rd of 4 is 100
    expect(pageLoadReport([100, 100, 2500, 2600]).met).toBe(false); // the 3rd of 4 is 2500: not under
    expect(pageLoadReport([100, 2400, 2600, 2700]).p75).toBe(2600);
  });

  it('refuses nothing to measure', () => {
    expect(() => pageLoadReport([])).toThrow(/No values/);
  });
});

describe('fillFragment', () => {
  it('writes the reference document so that the editor reads back what the fixture says', () => {
    const schema = closeSchema(getSchema(extensions(new Y.Doc())));
    const document = new Y.Doc();
    const fragment = document.getXmlFragment(FRAGMENT);
    fillFragment(fragment, referenceDocument() as never);
    const read = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    expect(read.toJSON()).toEqual(schema.nodeFromJSON(referenceDocument()).toJSON());
  });

  it('puts what a typist appends in the last paragraph, where the receivers count', () => {
    const fragment = new Y.Doc().getXmlFragment(FRAGMENT);
    fillFragment(fragment, referenceDocument() as never);
    const before = tailLength(fragment);
    const last = fragment.get(fragment.length - 1) as Y.XmlElement;
    (last.get(0) as Y.XmlText).insert(before, 'abc');
    expect(tailLength(fragment)).toBe(before + 3);
  });
});
