// The one database client of a process. It connects as the runtime role,
// `ekdotico_app`, which holds rows and no structure (NFR-IC-17), and every query
// goes through Prisma's parameterised interface (NFR-SE-06, A05).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { settings } from './settings.ts';

let client: PrismaClient | undefined;

export function db(): PrismaClient {
  return (client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: settings().databaseUrl }, { schema: 'ekdotico' }),
  }));
}
