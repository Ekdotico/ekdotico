// The one case that the sign-in page states after sign-up: the account was created and the server could not
// start its session. The marker is a fixed constant with no personal data and no other effect; any other
// value is ignored, and the `return` parameter is untouched.
export const NOTICE_PARAMETER = 'notice';
export const NOT_SIGNED_IN_MARKER = 'account-created';

// The owner's approved statement (23 November 2026).
export const NOT_SIGNED_IN =
  'Your account was created, but you were not signed in. Sign in with your email address and password.';

/** The address that carries the case to the sign-in page. */
export const NOT_SIGNED_IN_PATH = `/sign-in?${NOTICE_PARAMETER}=${NOT_SIGNED_IN_MARKER}`;
