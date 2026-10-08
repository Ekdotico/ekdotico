// The identity library's handler (API design, "Sign-in and identity"). Which of
// its endpoints answer is settled in src/lib/auth/auth.ts, and which of them a
// person without a session reaches, in src/proxy.ts. No endpoint that answers
// is a GET, so no GET is mounted.
import { auth } from '../../../../lib/auth/auth.ts';

export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return auth().handler(request);
}
