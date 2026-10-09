// Register A102, NFR-SE-17: whatever keeps the web application from starting
// stops the process. Left alone, Next.js logs a failed instrumentation hook,
// stays up, and answers every request with a 500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startTimers = vi.fn();
const refuseBuiltCollabRewrite = vi.fn();
const ORIGIN = 'https://app.example.test';
let exit: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

/** The modules the hook loads, each standing in for the real one unless a test replaces it. */
function modules(replaced: Record<string, () => object> = {}) {
  const all: Record<string, () => object> = {
    '../../src/lib/settings.ts': () => ({
      loadSettings: () => ({ appOrigin: ORIGIN }),
      refuseBuiltCollabRewrite,
    }),
    // No build, unless a test has one: the repository's own `.next` is not read.
    'node:fs': () => ({
      readFileSync: () => {
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      },
    }),
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
  refuseBuiltCollabRewrite.mockReset();
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
        refuseBuiltCollabRewrite,
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

  // docs/operations/deployment.md, item 9: `next start` serves the rewrites of
  // the build, so the build is what is checked, from where it is read.
  it('hands the routes manifest of the build to the check of the development rewrite', async () => {
    const readFileSync = vi.fn(() => 'the manifest');
    modules({ 'node:fs': () => ({ readFileSync }) });
    await register();
    expect(readFileSync).toHaveBeenCalledWith('.next/routes-manifest.json', 'utf8');
    expect(refuseBuiltCollabRewrite).toHaveBeenCalledWith(ORIGIN, 'the manifest');
    expect(exit).not.toHaveBeenCalled();
  });

  it('hands a build that is not there to the check as none, which refuses it off localhost; any other fault of the read stops the process', async () => {
    modules();
    await register();
    expect(refuseBuiltCollabRewrite).toHaveBeenCalledWith(ORIGIN, null);
    expect(exit).not.toHaveBeenCalled();

    // The check itself, and not a stand-in: no build, and an origin that is not on localhost.
    vi.resetModules();
    startTimers.mockClear();
    const real =
      await vi.importActual<typeof import('../../src/lib/settings.ts')>('../../src/lib/settings.ts');
    modules({
      '../../src/lib/settings.ts': () => ({
        loadSettings: () => ({ appOrigin: ORIGIN }),
        refuseBuiltCollabRewrite: real.refuseBuiltCollabRewrite,
      }),
    });
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/routes manifest of the build was not found/));
    expect(startTimers).not.toHaveBeenCalled();
    exit.mockClear();

    vi.resetModules();
    modules({
      'node:fs': () => ({
        readFileSync: () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      }),
    });
    await register();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stops the process where the build holds the development rewrite', async () => {
    refuseBuiltCollabRewrite.mockImplementation(() => {
      throw new Error('This build passes /collab to the collaboration server itself.');
    });
    modules();
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledWith('This build passes /collab to the collaboration server itself.');
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
