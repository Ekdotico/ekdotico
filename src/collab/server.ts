// The collaboration server process. In the walking skeleton it only answers its
// health check; Hocuspocus is mounted here when the editor is built.
import { createServer } from 'node:http';
import { assertContractVersion } from '../lib/istorico/index.ts';
import { loadSettings } from '../lib/settings.ts';

export const HEALTH_PATH = '/collab/health';

export function createCollabServer() {
  return createServer((request, response) => {
    // NFR-SE-05 (c): reports whether the service is up and returns nothing else.
    if (request.method === 'GET' && request.url === HEALTH_PATH) {
      response.writeHead(200, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    response.writeHead(404).end();
  });
}

if (import.meta.main) {
  loadSettings();
  assertContractVersion();
  const port = Number(process.env.COLLAB_PORT ?? 1234);
  const server = createCollabServer().listen(port, () => {
    console.log(`collaboration server listening on ${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
