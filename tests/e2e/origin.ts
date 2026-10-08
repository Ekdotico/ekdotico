/**
 * The port the end-to-end tests serve the application on: 3000, or `E2E_PORT`
 * where a development server already holds that one.
 */
export const APP_PORT = process.env.E2E_PORT ?? '3000';

/** The origin the end-to-end tests serve the application from, and the only one a page may ask (FR-AU-88). */
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
