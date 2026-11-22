import { returnPath } from '../../../../lib/http.ts';

// `SIGN_IN_PATH` and `RETURN_PARAMETER` of src/proxy.ts, which is a module of
// the server: tests/unit/editor.test.ts holds the two together.
const SIGN_IN_PATH = '/sign-in';
const RETURN_KEY = 'return';

/**
 * The address of "Sign in again" (FR-AU-07): the sign-in page with the page
 * the person is on as the place to return to, written as the proxy writes it
 * and through the same `returnPath`, so that a value of another origin is `/`.
 */
export function signInAgainHref(current: string): string {
  return `${SIGN_IN_PATH}?${new URLSearchParams({ [RETURN_KEY]: returnPath(current) }).toString()}`;
}
