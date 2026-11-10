// The reading of a request's body (src/lib/http.ts). Next.js cuts a body its proxy sees at
// `proxyClientMaxBodySize` (next.config.ts) and ends the stream as if the body were whole
// (next/dist/server/body-streams.js), so a route can be handed fewer bytes than were sent, with no error. A body
// that declares its length and ends short of it is refused, here, for every route at once (the second review of
// pull request 75, B3). The weakening that fails these: the length not compared at the end of the body.
import { describe, expect, it } from 'vitest';
import { IncompleteBody, readBytes, readJson, readWhole } from '../../src/lib/http.ts';

const at = 'https://app.example.test/api/x';
/** A request whose body is `sent`, with `declared` as its Content-Length where one is given. */
function request(sent: string, declared?: number) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sent));
      controller.close();
    },
  });
  return new Request(at, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(declared === undefined ? {} : { 'content-length': String(declared) }),
    },
    body,
    duplex: 'half',
  } as RequestInit);
}

describe('readBytes', () => {
  it('refuses a body that ends short of its declared length', async () => {
    await expect(readBytes(request('{"a":1}', 20), 1024)).rejects.toBeInstanceOf(IncompleteBody);
  });

  it('refuses a body longer than it declared as well', async () => {
    await expect(readBytes(request('{"a":1}', 3), 1024)).rejects.toBeInstanceOf(IncompleteBody);
  });

  it('reads a body whose length is what it declared', async () => {
    expect((await readBytes(request('{"a":1}', 7), 1024))?.toString()).toBe('{"a":1}');
  });

  it('reads a body that declares no length, which has nothing to be compared with', async () => {
    expect((await readBytes(request('{"a":1}'), 1024))?.toString()).toBe('{"a":1}');
  });

  it('still answers a body past its bound with null, before it ends', async () => {
    expect(await readBytes(request('x'.repeat(2000), 5000), 1024)).toBeNull();
  });
});

describe('the callers of readBytes', () => {
  it('readJson: a body short of its length is no JSON, the answer of a malformed body', async () => {
    expect(await readJson(request('{"a":1}', 20), 1024)).toBeNull();
    expect(await readJson(request('{"a":1}', 7), 1024)).toEqual({ a: 1 });
  });

  it('readWhole: a body short of its length is read as no body, which no reading of JSON accepts', async () => {
    expect((await readWhole(request('{"a":1}', 20), 1024))?.length).toBe(0);
    expect((await readWhole(request('{"a":1}', 7), 1024))?.toString()).toBe('{"a":1}');
    expect(await readWhole(request('x'.repeat(2000)), 1024)).toBeNull();
  });
});
