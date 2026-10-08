// The one Valkey connection of a process. Counters that must hold across
// instances live here and never in the memory of one instance (NFR-SE-07,
// NFR-SC-04).
import { Redis } from 'ioredis';
import { settings } from './settings.ts';

let client: Redis | undefined;

export function valkey(): Redis {
  return (client ??= new Redis(settings().valkeyUrl, { maxRetriesPerRequest: 2 }));
}
