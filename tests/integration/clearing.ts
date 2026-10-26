// What the integration tests of a clearing share (FR-AU-91; docs/plan/slice-23.md): people with sessions, documents
// with collaborators and images, the routes as Next.js calls them, and the account's own view of what is left.
// The modules under test are imported after `prepare` has set the environment (tests/integration/identity.ts).
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, signIn } from './identity.ts';
import { MemoryStorage } from './image-storage.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOTICE_DAYS = 7;
/** A title no log, email or message may hold (NFR-SE-19). */
export const TITLE = 'title-that-no-log-and-no-email-may-hold';
export const MAIL = join(tmpdir(), `ekdotico-clearing-mail-${randomUUID()}`);

type Loaded = Awaited<ReturnType<typeof load>>;

let addresses = 0;
/** A network address no earlier request came from, so that no count of one address gets in the way. */
export const net = () => ({ 'x-forwarded-for': `10.40.${Math.floor(++addresses / 250)}.${addresses % 250}` });

export function world(
  loaded: Loaded,
  modules: {
    createDocument: (userId: string) => Promise<{ id: string }>;
    clearRoute: {
      POST: (request: Request) => Promise<Response>;
      DELETE: (request: Request) => Promise<Response>;
    };
    oneRoute: {
      DELETE: (request: Request, context: { params: Promise<{ documentId: string }> }) => Promise<Response>;
    };
    useImageStorage: (storage: MemoryStorage | null | undefined) => void;
  },
) {
  const { auth, db } = loaded;
  let people = 0;

  async function person(prefix = 'owner') {
    const email = `${prefix}${++people}-${randomUUID().slice(0, 6)}@example.com`;
    const id = await createAccount(auth, email);
    const signedIn = async () => cookiesOf(await signIn(auth, email));
    return { id, email, signedIn, cookie: await signedIn() };
  }

  /** A document of this account, with a title no log may hold. */
  async function documentOf(userId: string, title = TITLE): Promise<string> {
    const { id } = await modules.createDocument(userId);
    await db().document.update({ where: { id }, data: { title } });
    return id;
  }

  const share = (documentId: string, userId: string, role: 'EDITOR' | 'VIEWER' | 'REVIEWER' = 'VIEWER') =>
    db().documentCollaborator.create({ data: { documentId, userId, role } });

  /** A pending invitation, as one that was sent (its email claimed), to an address. */
  const invite = (documentId: string, invitedById: string, email: string) =>
    db().documentInvitation.create({
      data: {
        documentId,
        invitedById,
        email,
        role: 'VIEWER',
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 14 * DAY_MS),
        emailClaimedAt: new Date(),
      },
    });

  /** Marks a document as deleted this long ago, as the deletion would have. */
  const deletedAgo = (id: string, userId: string, ms: number) =>
    db().document.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - ms), deletedById: userId },
    });

  /** An image of the document, in the store and in the table. */
  async function image(documentId: string, storage: MemoryStorage, userId: string): Promise<string> {
    const objectKey = `documents/${documentId}/${randomUUID()}`;
    await storage.put(objectKey, new Uint8Array([1, 2, 3]), 'image/png');
    await db().documentImage.create({
      data: { documentId, objectKey, contentType: 'image/png', byteSize: 3, uploadedById: userId },
    });
    return objectKey;
  }

  const request = (
    method: string,
    path: string,
    cookie?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...net(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const clear = (cookie: string, body: unknown, headers: Record<string, string> = {}) =>
    modules.clearRoute.POST(request('POST', '/api/account/documents/clear', cookie, body, headers));
  const cancelAll = (cookie: string) =>
    modules.clearRoute.DELETE(request('DELETE', '/api/account/documents/clear', cookie));
  const cancelOne = (cookie: string, documentId: string) =>
    modules.oneRoute.DELETE(request('DELETE', `/api/account/documents/clear/${documentId}`, cookie), {
      params: Promise.resolve({ documentId }),
    });

  const row = (id: string) => db().document.findUnique({ where: { id } });
  const exists = async (id: string) => (await row(id)) !== null;
  const logged = () =>
    db().securityLogEntry.findMany({ select: { kind: true, userId: true, documentId: true } });

  return {
    person,
    documentOf,
    share,
    invite,
    deletedAgo,
    image,
    request,
    clear,
    cancelAll,
    cancelOne,
    row,
    exists,
    logged,
    PASSWORD,
  };
}

export const parsedBodies = new WeakMap<
  Response,
  Promise<{ error?: { code: string; message: string } } & Record<string, unknown>>
>();
export function json(response: Response) {
  if (!parsedBodies.has(response)) parsedBodies.set(response, response.json());
  return parsedBodies.get(response)!;
}
export const codeOf = async (response: Response) => (await json(response)).error?.code;
