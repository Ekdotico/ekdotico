// The one database client of a process. It connects as the runtime role,
// `ekdotico_app`, which holds rows and no structure (NFR-IC-17), and every query
// goes through Prisma's parameterised interface (NFR-SE-06, A05).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { settings } from './settings.ts';

let client: PrismaClient | undefined;

export function db(): PrismaClient {
  return (client ??= new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: settings().databaseUrl,
        // NFR-SE-06 (A10): a database that does not answer fails the request
        // within seconds; it never holds it open. The first bounds the wait
        // for a connection, the second is kept by the server, and the third by
        // the driver where the server itself has gone quiet.
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 5000,
      },
      { schema: 'ekdotico' },
    ),
  }));
}
