// Register A102, NFR-SE-17: whatever keeps the web application from starting
// stops the process. Left alone, Next.js logs a failed instrumentation hook,
// stays up, and answers every request with a 500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startTimers = vi.fn();
let exit: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

/** The four modules the hook loads, each standing in for the real one unless a test replaces it. */
function modules(replaced: Record<string, () => object> = {}) {
  const all: Record<string, () => object> = {
    '../../src/lib/settings.ts': () => ({ loadSettings: () => {} }),
    '../../src/lib/istorico/index.ts': () => ({ assertContractVersion: () => {} }),
    '../../src/lib/timers.ts': () => ({ startTimers }),
    '../../src/lib/auth/auth.ts': () => ({ auth: () => ({ $context: Promise.resolve({}) }) }),
    ...replaced,
  };
  for (const [path, factory] of Object.entries(all)) vi.doMock(path, factory);
}

async function register() {
  const hook = await import('../../src/instrumentation.ts');
  await hook.register();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  startTimers.mockClear();
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the start of the web application', () => {
  it('starts the timers and leaves the process running where nothing is wrong', async () => {
    modules();
    await register();
    expect(startTimers).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops the process where a setting is refused', async () => {
    modules({
      '../../src/lib/settings.ts': () => ({
        loadSettings: () => {
          throw new Error('FOUNDING_TEAM_EMAILS is not set.');
        },
      }),
    });
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith('FOUNDING_TEAM_EMAILS is not set.');
    expect(startTimers).not.toHaveBeenCalled();
  });

  it('stops the process where a module cannot be loaded', async () => {
    modules({
      '../../src/lib/timers.ts': () => {
        throw new Error('the module could not be loaded');
      },
    });
    await register();
    expect(exit).toHaveBeenCalledWith(1);
  });

  // The library builds its configuration in the background: `auth()` returns
  // before a refusal, which arrives as the rejection of `$context`.
  it('stops the process where the identity library refuses its configuration', async () => {
    modules({
      '../../src/lib/auth/auth.ts': () => ({
        auth: () => ({ $context: Promise.reject(new Error('The configuration was refused.')) }),
      }),
    });
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith('The configuration was refused.');
    expect(startTimers).not.toHaveBeenCalled();
  });
});
