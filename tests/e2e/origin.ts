/**
 * The origin the end-to-end tests serve the application from, and the only one
 * a page may ask (FR-AU-88). The port is 3000 unless E2E_PORT names another,
 * for a machine on which 3000 is taken.
 */
export const APP_ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT || '3000'}`;
