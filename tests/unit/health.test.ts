import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../../src/app/api/health/route.ts';
import { createCollabServer, HEALTH_PATH } from '../../src/collab/server.ts';

// NFR-SE-05 (c): a health check reports whether the service is up and returns nothing else.
describe('the health check of the web application', () => {
  it('answers 200 with an empty body', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});

describe('the health check of the collaboration server', () => {
  const server = createCollabServer({ collabStoreDelayMs: 2000, collabStoreMaxMs: 10000 }).httpServer;
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  // The owner's amendment to choice C20 (8 October 2026). Subscribed, lost,
  // and subscribed again: tests/integration/collab-events-subscribe.test.ts.
  it('answers 503 with an empty body while it is not subscribed to the channel of deletions', async () => {
    const response = await fetch(base + HEALTH_PATH);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('answers nothing else', async () => {
    expect((await fetch(base + '/')).status).toBe(404);
    expect((await fetch(base + HEALTH_PATH, { method: 'POST' })).status).toBe(404);
  });
});
