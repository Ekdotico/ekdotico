import { defineConfig, env } from 'prisma/config';

// Migrations run as ekdotico_migrate, which only the deployment pipeline uses
// (NFR-IC-17). The connection string ends `?schema=ekdotico`, so the one
// migration history lives inside the application schema (contract IC-23).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('MIGRATE_DATABASE_URL') },
});
