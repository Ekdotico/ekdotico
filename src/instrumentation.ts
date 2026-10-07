// Runs once when the web application's server starts. Loading the settings here
// makes the process refuse to start without FOUNDING_TEAM_EMAILS (register A102).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadSettings } = await import('./lib/settings.ts');
    loadSettings();
  }
}
