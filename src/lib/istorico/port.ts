// The α subset of integration contract 0.1.0, implemented in the ekdotico
// repository for Ekdotico α 0.1.0. It is also the whole content of
// @ekdotico/istorico-contract 0.1.0, when Istorico publishes that package.
// Server side only: nothing here is loaded in the browser.
export const CONTRACT_VERSION = '0.1.0';

export type DocumentId = string; // UUID, canonical lower-case text (IC-25)
export type UserId = string;     // the application's User.id, never an email address
export type WorkspaceKind = 'personal' | 'institutional';

export type Result<T, E extends string = never> =
  | { ok: true; value: T }
  | { ok: false; error: E | 'unavailable' | 'unsupported'; retryable: boolean };

export interface Capabilities {
  adapter: 'noop' | 'istorico';
  contractVersion: string;
  recording: boolean;
  sealing: boolean;
  reading: boolean;
  lineage: boolean;
  erasure: boolean;
}

export interface RegisterDocument {
  documentId: DocumentId;
  ownerUserId: UserId;
  workspaceKind: WorkspaceKind;
  workspaceId: string;
  createdAt: string; // ISO 8601, UTC
}

export interface ErasureRequest {
  requestId: string;
  subjectUserId: UserId;
  documents: {
    documentId: DocumentId;
    role: 'owner' | 'contributor';
    workspaceKind: WorkspaceKind;
    enrolledAt?: string;
    unenrolledAt?: string;
    reviewPeriodEndsAt?: string;
  }[];
}

export interface ErasureOutcome {
  documentId: DocumentId;
  outcome: 'erased' | 'pseudonymised' | 'held' | 'no-record';
}

// The α subset of IstoricoPort. The whole port (IC-09) adds methods to this
// interface and removes none.
export interface IstoricoPort {
  capabilities(): Capabilities;
  registerDocument(input: RegisterDocument): Promise<Result<void>>;
  erase(input: ErasureRequest): Promise<Result<ErasureOutcome[]>>;
}

// The no-op adapter (IC-14). It stores nothing and creates nothing (IC-15).
export const noopAdapter: IstoricoPort = {
  capabilities: () => ({
    adapter: 'noop',
    contractVersion: CONTRACT_VERSION,
    recording: false,
    sealing: false,
    reading: false,
    lineage: false,
    erasure: false,
  }),
  registerDocument: async () => ({ ok: true, value: undefined }),
  erase: async (input) => ({
    ok: true,
    value: input.documents.map((d) => ({
      documentId: d.documentId,
      outcome: 'no-record' as const,
    })),
  }),
};
