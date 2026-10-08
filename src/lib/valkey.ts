// The one Valkey connection of a process. Counters that must hold across
// instances live here and never in the memory of one instance (NFR-SE-07,
// NFR-SC-04).
import { Redis } from 'ioredis';
import { settings } from './settings.ts';

let client: Redis | undefined;

export function valkey(): Redis {
  if (client) return client;
  // NFR-SE-06 (A10): a Valkey that does not answer fails the request within
  // seconds; it never holds it open, and never admits it.
  client = new Redis(settings().valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    commandTimeout: 5000,
  });
  // Without a listener the client prints the error itself, with the address
  // of the server. NFR-SE-19: the class of the fault and nothing else.
  client.on('error', (error) => console.error(`valkey: connection fault (${error.name})`));
  return client;
}
