// The tests contract clause IC-18 asks for (item 7): they assert the code of
// IC-49 line for line, the capabilities, the two results, and that the adapter
// stores nothing (IC-15). The conformance tests of the contract package take
// their place when the application adopts it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertContractVersion,
  CONTRACT_VERSION,
  istorico,
  type ErasureRequest,
  type IstoricoPort,
  type RegisterDocument,
} from '../../src/lib/istorico/index.ts';

const source = readFileSync('src/lib/istorico/port.ts', 'utf8');

const registration: RegisterDocument = {
  documentId: '0b9f1c0e-3c53-4c8a-9d1e-5a2f6f0c7b11',
  ownerUserId: 'user_1',
  workspaceKind: 'personal',
  workspaceId: 'workspace_1',
  createdAt: '2026-10-08T09:00:00.000Z',
};
const erasure: ErasureRequest = {
  requestId: 'request_1',
  subjectUserId: 'user_1',
  documents: [
    { documentId: '0b9f1c0e-3c53-4c8a-9d1e-5a2f6f0c7b11', role: 'owner', workspaceKind: 'personal' },
    { documentId: '7d1d0f5e-8a44-4a8e-b0a3-2f4f3f9f6c22', role: 'contributor', workspaceKind: 'personal' },
  ],
};

describe('the α subset of the port (contract IC-49)', () => {
  // The file is the code of IC-49 as the contract page gives it at Docs commit
  // f4ec614, byte for byte. A change to it is a change to the contract: make it
  // on the contract page first, copy it again, and replace this hash on purpose.
  it('is the code of IC-49, line for line', () => {
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '1abd78b501536a8f721deab41ad84279157adface13a59b6d297ef26684db314',
    );
  });

  it('is at contract version 0.1.0', () => {
    expect(CONTRACT_VERSION).toBe('0.1.0');
  });
});

describe('the no-op adapter (IC-14)', () => {
  const port = istorico();

  it('reports no capability', () => {
    expect(port.capabilities()).toEqual({
      adapter: 'noop',
      contractVersion: '0.1.0',
      recording: false,
      sealing: false,
      reading: false,
      lineage: false,
      erasure: false,
    });
  });

  it('answers a registration with success and no value', async () => {
    expect(await port.registerDocument(registration)).toEqual({ ok: true, value: undefined });
  });

  it('answers an erasure with "no-record" for every document, in order', async () => {
    expect(await port.erase(erasure)).toEqual({
      ok: true,
      value: [
        { documentId: '0b9f1c0e-3c53-4c8a-9d1e-5a2f6f0c7b11', outcome: 'no-record' },
        { documentId: '7d1d0f5e-8a44-4a8e-b0a3-2f4f3f9f6c22', outcome: 'no-record' },
      ],
    });
    expect(await port.erase({ ...erasure, documents: [] })).toEqual({ ok: true, value: [] });
  });

  // IC-15: it creates no session, signature, hash, or time, and stores nothing.
  it('stores nothing and reaches nothing', async () => {
    // It can reach no database, file, network, or clock: the module imports
    // nothing and names none of them.
    expect(source).not.toMatch(/\bimport\b|\brequire\b|\bprocess\b|\bglobalThis\b|\bfetch\b|\bDate\b/);
    // No module-level binding exists that could hold state, and no source of an
    // identifier, a time, or a random value is named.
    expect(source.match(/\b(?:const|let|var|class|function)\s+\w+/g)).toEqual([
      'const CONTRACT_VERSION',
      'const noopAdapter',
    ]);
    expect(source).not.toMatch(/\b(?:crypto|performance|Math|Intl|Temporal)\b/);
    // It keeps nothing between calls: a second call answers as the first did,
    // whatever came between, and the capabilities never change.
    const first = await port.erase(erasure);
    await port.registerDocument(registration);
    expect(await port.erase(erasure)).toEqual(first);
    expect(port.capabilities()).toEqual(port.capabilities());
    // It does not change what it is given.
    const frozen = Object.freeze({ ...erasure, documents: Object.freeze([...erasure.documents]) });
    await expect(port.erase(frozen as ErasureRequest)).resolves.toMatchObject({ ok: true });
  });
});

describe('the start-up check (IC-41)', () => {
  it('passes for the adapter the application carries', () => {
    expect(() => assertContractVersion()).not.toThrow();
  });

  it('refuses an adapter built against another version of the contract', () => {
    const other: IstoricoPort = {
      ...istorico(),
      capabilities: () => ({ ...istorico().capabilities(), contractVersion: '0.2.0' }),
    };
    expect(() => assertContractVersion(other)).toThrow(/contract 0\.2\.0/);
  });
});
