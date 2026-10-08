// What a page does where the database, Valkey, or the identity library cannot
// answer (NFR-SE-06 A10, NFR-SE-19). A route handler has its own `catch`; a
// page has none, and Next.js prints an error a page throws whole, with a
// message that can quote a row. So what a page reads runs through `reading`.
import { faultOf } from '../lib/fault.ts';

/**
 * Runs what a page reads. A fault is printed as its class and code alone, and
 * the error thrown on holds nothing of it: that one is what Next.js logs, and
 * what src/app/error.tsx answers with the fixed statement.
 *
 * Only what reads goes in here. `redirect` and `notFound` signal by throwing,
 * and so does `headers` while a page is built: none of them is a fault.
 */
export async function reading<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(`page: request failed (${faultOf(error)})`);
    throw new Error('page: fault');
  }
}
