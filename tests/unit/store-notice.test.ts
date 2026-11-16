// FR-ED-23, NFR-RE-07 (register D294, the audit's row R-12): after a failed store the writers see the syncing
// state with a sentence that the document is not yet saved, and "In sync" again once a store has succeeded.
// The sentence is written out here, not taken from the code under test.
import { describe, expect, it } from 'vitest';
import { syncStatus, type ConnectionState } from '../../src/lib/collab/client.ts';
import { readStoreNotice, storeNotice } from '../../src/lib/collab/protocol.ts';

const NOT_SAVED = 'This document is not yet saved. Ekdotico keeps trying to save it.';
const UNSENT = 'Changes that are not yet sent are lost if this tab is closed.';
const state = (change: Partial<ConnectionState>): ConnectionState => ({
  phase: 'connected',
  opened: true,
  unsent: false,
  ...change,
});

describe('the notice of a store', () => {
  // Mutation S01: the notice is read without checking its fields.
  it('is read back, and nothing else is read as one', () => {
    expect(readStoreNotice(storeNotice(false))).toEqual({ stored: false });
    expect(readStoreNotice(storeNotice(true))).toEqual({ stored: true });
    for (const other of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ kind: 'role', stored: false }),
      JSON.stringify({ kind: 'store' }),
      JSON.stringify({ kind: 'store', stored: 'no' }),
      JSON.stringify({ kind: 'store', stored: false, extra: 1 }),
    ]) {
      expect(readStoreNotice(other)).toBeNull();
    }
  });
});

describe('the sync status after a failed store', () => {
  // Mutation S02: the indicator says "In sync" while the server holds what it could not store.
  it('shows the syncing state with the sentence, and not "In sync"', () => {
    expect(syncStatus(state({ unstored: true }))).toEqual({
      state: 'syncing',
      label: `Syncing. ${NOT_SAVED}`,
    });
  });

  it('keeps the words about unsent changes beside it', () => {
    expect(syncStatus(state({ unstored: true, unsent: true }))).toEqual({
      state: 'syncing',
      label: `Syncing. ${NOT_SAVED} ${UNSENT}`,
    });
  });

  it('shows "In sync" once a store has succeeded', () => {
    expect(syncStatus(state({ unstored: false }))).toEqual({ state: 'synced', label: 'In sync' });
    expect(syncStatus(state({}))).toEqual({ state: 'synced', label: 'In sync' });
  });

  it('leaves the words of a lost or restored connection as they are', () => {
    for (const phase of ['restoring', 'lost', 'opening'] as const) {
      expect(syncStatus(state({ phase, unstored: true })).label).not.toContain(NOT_SAVED);
    }
  });
});
