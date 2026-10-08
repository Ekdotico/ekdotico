# 0004 — One line patched out of the identity library

- **Date:** 8 October 2026.
- **Requirement:** NFR-SE-19. No log holds an email address, a name, a token, or a secret. The owner's decision of the day: patch the line out of the pinned version, and report it upstream.

## What the line did

`@better-auth/core` 1.7.7, `dist/db/adapter/factory.mjs`, in `handleFallbackJoin`:

```js
} catch (error) {
	logger.error(`Failed to query fallback join for model ${modelName}:`, { where, limit: joinConfig.limit });
	console.error(error);
	throw error;
}
```

The library reads a session and then its user in a second query, because the application does not switch on its native joins. A fault of that query was handed whole to `console.error`, past the logger the application configures (`src/lib/auth/auth.ts`), which prints only that the library reported an error. What reached the log was the error of the database as Prisma raises it: its message, the name of the table, and whatever the database quoted of the query.

## What is done

`patches/@better-auth__core@1.7.7.patch` deletes the one line, and `pnpm.patchedDependencies` in `package.json` applies it at every install. Nothing takes its place: the line above it already goes through the configured logger, and the error is thrown on, so the caller reports it by its class and code (`faultOf`).

Two tests fail where the patch is not applied: `tests/unit/library-patch.test.ts` reads the installed file, and `tests/integration/auth-config.test.ts` ("prints nothing of a fault in the second query of a session") provokes the fault against a real database.

## At each update of the library

`better-auth` and `@better-auth/core` move together, and the patch names the version, so an update leaves it unapplied and pnpm says so. Then:

1. Read `handleFallbackJoin` in the new version. If the line is gone, delete the patch, its entry in `package.json`, and the unit test; keep the integration test.
2. If it is still there, make the patch again for the new version: `pnpm patch @better-auth/core@<version>`, delete the line, `pnpm patch-commit <directory>`.
3. Search the new version for other direct calls of `console` on a path the application reaches: `grep -rn "console\." node_modules/better-auth/dist node_modules/.pnpm/@better-auth+core@*/node_modules/@better-auth/core/dist`.

## Upstream

Not yet reported on the day this was written. The report is the owner's to send; when it is filed, add its link here.
