// Runs once when the web application's server starts. Without FOUNDING_TEAM_EMAILS
// the process exits (register A102). Next.js would otherwise log a failed
// instrumentation hook, stay up, and answer every request with a 500.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadSettings } = await import('./lib/settings.ts');
    const { assertContractVersion } = await import('./lib/istorico/index.ts');
    const { startTimers } = await import('./lib/timers.ts');
    const { auth } = await import('./lib/auth/auth.ts');
    try {
      loadSettings();
      assertContractVersion();
      // NFR-SE-17: a configuration the library would not take as written stops the process here.
      auth();
      // NFR-RE-15: the scheduled work of the application runs on timers in this process.
      startTimers();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
}
