// A check-in with Healthchecks.io (register D274, D275, D280; NFR-RE-03, NFR-RE-10, NFR-RE-15).
//
// The service emails the owner when the calls STOP. Each check is a ping address, and each is switched on
// by its own setting: where the setting is absent nothing is called.
//
// The address is a secret: anyone who holds it can keep the alarm quiet. So this module never writes it
// to a line, an error message or a thrown value, and the settings it validates are refused by name alone.
// A check-in is a GET with no body and no header of ours: it carries no personal data (D274). `/fail`
// is the one signal of a failure that the service's protocol has; nothing is sent for "start".
//
// A check-in never throws and never waits long: its caller is a timer, a job, or the server's own check,
// and none of them may fail or stall because the monitor could not be reached.

type Env = Record<string, string | undefined>;

/** The one host of D275. A ping address of an own-hosted instance is not decided, so it is refused. */
const HOST = 'hc-ping.com';
const TIMEOUT_MS = 5000;

/**
 * The ping address in `env[name]`, or undefined where it is absent or empty. Refuses, naming the setting
 * and never the value, anything that is not `https://hc-ping.com/` and a path of letters, digits, `-`, `_`
 * and `/` (a check's UUID, or the project's key and the check's slug).
 */
export function checkInUrl(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.hostname !== HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(url.pathname)
  ) {
    throw new Error(`${name} must be a ping address at https://${HOST}/ and nothing else.`);
  }
  return value;
}

/**
 * Checks in at `url`, or at `url/fail` to say the thing failed. Resolves true where the service answered
 * with success. Does nothing, and resolves false, where `url` is undefined.
 */
export async function checkIn(url: string | undefined, outcome: 'ok' | 'fail' = 'ok'): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(outcome === 'fail' ? `${url}/fail` : url, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never follow: the answer of the service is not read, and a redirect would carry the call elsewhere.
      redirect: 'manual',
    });
    return response.ok;
  } catch {
    // Not a word of the fault: it can quote the address.
    return false;
  }
}
