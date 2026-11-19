// The fixed figures of procedure 1 and the arithmetic of its page-load step (NFR-PE-01; register D295, D297).
import { percentile } from './stats.ts';

/** Keystrokes a second: the rate at which the client sends its changes (register D295). */
export const DEFAULT_RATE = 4;
/** The budget of the largest contentful paint at P75, in milliseconds (register D297). */
export const LCP_BUDGET_MS = 2500;
/** Loads of each page. The specification says "many times" and gives no number: 20 is this harness's default (a flag). */
export const DEFAULT_LOADS = 20;

export interface PageLoadReport {
  loads: number;
  p75: number;
  budgetMs: number;
  met: boolean;
}

/** The P75 of the times of largest contentful paint of one page, against the budget (met when under it). */
export function pageLoadReport(times: readonly number[], budgetMs = LCP_BUDGET_MS): PageLoadReport {
  const p75 = Math.round(percentile(times, 75) * 100) / 100;
  return { loads: times.length, p75, budgetMs, met: p75 < budgetMs };
}
