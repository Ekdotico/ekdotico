// Work that a request leaves for after its response (FR-AU-86, FR-AU-87,
// NFR-RE-15): the email of the account is "handed to the service after the
// response to the request that caused it has been returned", and for a password
// reset so is everything that depends on whether the address has an account,
// "so that neither the answer nor the time it takes shows who is registered".
//
// An endpoint inside the identity library cannot reach `after` of Next.js, and
// nothing under src/lib imports Next.js. So the endpoint leaves its work here,
// and the route that called the library's handler passes it to `after`
// (src/app/api/auth/[...all]/route.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import { faultOf } from './fault.ts';

type Task = () => Promise<unknown>;

const collected = new AsyncLocalStorage<Task[]>();

/**
 * Leaves `task` for after the response of the request being served. A
 * failure prints `name` and the class and code of the fault, and nothing
 * else: an error's message can quote a row or an address (NFR-SE-19).
 *
 * It throws where no request is collecting. Work dropped in silence would be
 * an email that is never sent, with the same answer as one that is.
 */
export function afterResponse(name: string, task: Task): void {
  assertCollecting().push(() =>
    task().catch((error: unknown) => console.error(`after response: ${name} failed (${faultOf(error)})`)),
  );
}

/**
 * Throws where no request is collecting. An endpoint that will leave work
 * calls it first, before it writes anything: thrown after a commit, the fault
 * would answer that nothing was changed when something was.
 */
export function assertCollecting(): Task[] {
  const tasks = collected.getStore();
  if (!tasks) throw new Error('afterResponse: called outside a request that collects.');
  return tasks;
}

/** Runs `work`, and returns with its result the tasks it left. None has started. */
export async function collecting<T>(work: () => Promise<T>): Promise<{ result: T; tasks: Task[] }> {
  const tasks: Task[] = [];
  return { result: await collected.run(tasks, work), tasks };
}
