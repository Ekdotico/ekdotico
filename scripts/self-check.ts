// The server's check of its own public addresses (NFR-RE-03; register D280, D275). Run each minute by the
// systemd timer in docs/operations/deployment.md ("The server checks itself"):
//
//   node scripts/self-check.ts
//
// It calls `${APP_ORIGIN}/api/health` and `${APP_ORIGIN}/collab/health` and, after each one that answers
// 200, checks in at that check's address (HEALTHCHECK_WEB_URL, HEALTHCHECK_COLLAB_URL). The two are
// independent: one that fails neither checks in nor stops the other. A check-in that does not come is
// what makes the service email the owner. It holds no secret but the two addresses, which no line names.
//
// The gap, as D280 states it: it is the server calling itself, so a fault seen only from outside (a
// firewall rule that blocks others and not the server) is not caught.
//
// Exit codes: 0 both answered; 1 one or both did not; 2 a setting is wrong, before anything was called.
import { checkIn, checkInUrl } from '../src/lib/healthcheck.ts';

type Env = Record<string, string | undefined>;

const TIMEOUT_MS = 10_000;

/** Whether `address` answers 200. A fault is not described: it can quote the host. */
async function answers(address: string): Promise<boolean> {
  try {
    const response = await fetch(address, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Runs one round. Resolves with the exit code. */
export async function selfCheck(env: Env, log: (line: string) => void = console.log): Promise<0 | 1 | 2> {
  let origin: string;
  let web: string | undefined;
  let collab: string | undefined;
  try {
    const appOrigin = env.APP_ORIGIN;
    if (!appOrigin || !URL.canParse(appOrigin) || new URL(appOrigin).origin !== appOrigin) {
      throw new Error(
        'APP_ORIGIN must be an origin: a scheme, a host and an optional port, with nothing after.',
      );
    }
    origin = appOrigin;
    web = checkInUrl(env, 'HEALTHCHECK_WEB_URL');
    collab = checkInUrl(env, 'HEALTHCHECK_COLLAB_URL');
  } catch (error) {
    log(`self-check: refused: ${(error as Error).message}`);
    return 2;
  }
  const rounds: [string, string, string | undefined][] = [
    ['web application', `${origin}/api/health`, web],
    ['collaboration server', `${origin}/collab/health`, collab],
  ];
  let failed = false;
  for (const [name, address, ping] of rounds) {
    if (await answers(address)) {
      await checkIn(ping);
    } else {
      failed = true;
      log(`self-check: the ${name} did not answer 200`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await selfCheck(process.env));
