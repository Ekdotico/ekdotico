// Runs once when the web application's server starts. Without FOUNDING_TEAM_EMAILS
// the process exits (register A102). Next.js would otherwise log a failed
// instrumentation hook, stay up, and answer every request with a 500.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      // Inside the `try`: a module that fails to load stops the process as well.
      const { loadSettings, refuseBuiltCollabRewrite } = await import('./lib/settings.ts');
      const { assertContractVersion } = await import('./lib/istorico/index.ts');
      const { startTimers } = await import('./lib/timers.ts');
      const { auth } = await import('./lib/auth/auth.ts');
      const { readFileSync } = await import('node:fs');
      const { appOrigin, imageStorage } = loadSettings();
      // NFR-SE-18: a deployment with no object store stores no image: said once, where it can be read in the log.
      if (!imageStorage && !['localhost', '127.0.0.1'].includes(new URL(appOrigin).hostname)) {
        console.warn('No object store is set (IMAGE_STORAGE_*): no image can be uploaded or shown.');
      }
      // docs/operations/deployment.md, item 9: the rewrites this process serves
      // are those of the build, read from where `next start` reads them.
      let manifest: string | null = null;
      try {
        manifest = readFileSync('.next/routes-manifest.json', 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      refuseBuiltCollabRewrite(appOrigin, manifest);
      assertContractVersion();
      // NFR-SE-17: a configuration the library would not take as written stops
      // the process here. The library builds it in the background, and refuses
      // it by rejecting this promise; it opens no connection to do so.
      await auth().$context;
      // NFR-RE-15: the scheduled work of the application runs on timers in this process.
      startTimers();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
}
