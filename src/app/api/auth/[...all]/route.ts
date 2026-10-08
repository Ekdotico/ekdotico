// The identity library's handler (API design, "Sign-in and identity"). Which of
// its endpoints answer is settled in src/lib/auth/auth.ts, and which of them a
// person without a session reaches, in src/proxy.ts. No endpoint that answers
// is a GET, so no GET is mounted.
import { after } from 'next/server';
import { collecting } from '../../../../lib/after-response.ts';
import { auth } from '../../../../lib/auth/auth.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const { result, tasks } = await collecting(() => auth().handler(request));
  // FR-AU-86, FR-AU-87, NFR-RE-15: what an endpoint left for after its
  // response, the email of the account above all, starts once the response
  // has been returned.
  for (const task of tasks) after(task);
  return result;
}
