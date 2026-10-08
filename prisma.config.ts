import { defineConfig } from 'prisma/config';

// Migrations run as ekdotico_migrate, which only the deployment pipeline uses
// (NFR-IC-17). The connection string ends `?schema=ekdotico`, so the one
// migration history lives inside the application schema (contract IC-23).
//
// The address is read here and not required: generating the client, which every
// install does, needs no database. A migration without it fails at the connection.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.MIGRATE_DATABASE_URL ?? '' },
});
