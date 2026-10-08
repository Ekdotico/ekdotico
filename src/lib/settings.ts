// Settings read from the environment when a process starts. The web application
// and the collaboration server both load them through this one module
// (NFR-SE-17 (f)). Every secret is read here and nowhere else (NFR-SE-19).

/** A limit of NFR-SE-07: at most `max` in any `windowSeconds`. */
export interface Limit {
  max: number;
  windowSeconds: number;
}

// The initial values of NFR-SE-07, for the rows of α 0.1.0. Each is changed
// without a code change by the variable RATE_LIMIT_<NAME>, written `max/seconds`.
const LIMITS = {
  /** Requests to API routes, for each authenticated user. */
  API_PER_USER: [120, 60],
  /** Invitations created, for each authenticated user. */
  INVITATIONS_PER_USER: [20, 3600],
  /** Image uploads, for each authenticated user. */
  IMAGE_UPLOADS_PER_USER: [30, 600],
  /** Draft exports started, for each authenticated user. */
  EXPORTS_PER_USER: [10, 3600],
  /** Collaboration handshakes, for each authenticated user. */
  HANDSHAKES_PER_USER: [30, 60],
  /** Requests to the session-less pages and endpoints, for each network address. */
  SESSIONLESS_PER_ADDRESS: [20, 60],
  /** Failed sign-ins, for one email address from one network address. */
  FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: [5, 900],
  /** Failed sign-ins, for one email address from all network addresses. */
  FAILED_SIGN_IN_PER_EMAIL: [20, 3600],
  /** Password-reset requests, for each email address entered. */
  RESET_PER_EMAIL: [3, 3600],
  /** Password-reset requests, for each network address. */
  RESET_PER_ADDRESS: [10, 3600],
  /** Confirmation email for a changed address, for each authenticated user. */
  CONFIRMATION_EMAIL_PER_USER: [3, 3600],
  /** Requests to the admission endpoints, in all. */
  ADMISSION: [60, 60],
} as const satisfies Record<string, readonly [number, number]>;

export type LimitName = keyof typeof LIMITS;

export interface Settings {
  /** The founding team's addresses, lower case (FR-AU-83; register D114, A102). */
  foundingTeamEmails: readonly string[];
  /** The application's own origin, the one entry of the allow-list of NFR-SE-17 (c). */
  appOrigin: string;
  /** The connection string of the runtime role, `ekdotico_app` (NFR-IC-17). */
  databaseUrl: string;
  valkeyUrl: string;
  /** The identity library's secret; it also encrypts the second factor at rest (NFR-SE-17 (a), (e)). */
  authSecret: string;
  /** How many proxies stand between a client and this process (the owner's answer to Q5). */
  trustedProxyCount: number;
  /** FR-AU-84: both periods of a session, and the renewal interval. */
  sessionIdleSeconds: number;
  sessionRenewSeconds: number;
  sessionMaxSeconds: number;
  /** NFR-SE-17 (c): the lifetime of the signed copy of a session. */
  cookieCacheSeconds: number;
  /** FR-AU-82: the two limits on the length of a password. */
  passwordMinLength: number;
  passwordMaxLength: number;
  /** NFR-SE-19: how long a security log entry is kept. */
  securityLogRetentionDays: number;
  /** Where the local sink writes each message (register D70 (the three checks stand), D92: no real email yet). */
  emailSinkDirectory: string;
  /** The address messages are sent from. */
  emailFrom: string;
  limits: Readonly<Record<LimitName, Limit>>;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, hint: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

// The least a value may be is 1 wherever 0 would switch a rule off without a
// word: a session that has ended before it began, a log that keeps nothing, a
// password of no length.
function wholeNumber(env: Env, name: string, initial: number, least: 0 | 1): number {
  const value = env[name];
  if (value === undefined || value === '') return initial;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < least) {
    throw new Error(`${name} must be a whole number, ${least} or more.`);
  }
  return Number(value);
}

function limit(env: Env, name: LimitName): Limit {
  const value = env[`RATE_LIMIT_${name}`];
  const [max, windowSeconds] = LIMITS[name];
  if (value === undefined || value === '') return { max, windowSeconds };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value);
  if (!match)
    throw new Error(`RATE_LIMIT_${name} must be written max/seconds, for example ${max}/${windowSeconds}.`);
  return { max: Number(match[1]), windowSeconds: Number(match[2]) };
}

const DAY = 24 * 60 * 60;

export function loadSettings(env: Env = process.env): Settings {
  // NFR-SE-17 (b), (c): the identity library also reads variables of its own,
  // which can switch its telemetry on and add trusted origins whatever the
  // application configures. Refused here, so that both processes refuse. The
  // message holds the names and never a value.
  const ofTheLibrary = Object.keys(env).filter((name) => name.startsWith('BETTER_AUTH_'));
  if (ofTheLibrary.length > 0) {
    throw new Error(
      `Unset ${ofTheLibrary.join(', ')}: the identity library is configured by the application alone.`,
    );
  }
  // NFR-SE-07: a limit written under a name that is none of the limits would
  // change nothing, and the deployment would believe it had.
  const noLimit = Object.keys(env).filter(
    (name) => name.startsWith('RATE_LIMIT_') && !Object.hasOwn(LIMITS, name.slice('RATE_LIMIT_'.length)),
  );
  if (noLimit.length > 0) {
    throw new Error(
      `Unset ${noLimit.join(', ')}: no limit has that name. The names are in src/lib/settings.ts.`,
    );
  }
  const list = env.FOUNDING_TEAM_EMAILS;
  // A102: a process refuses to start where the setting is absent, so that a
  // deployment cannot lose the two-factor requirement by losing the setting.
  // A list with no address is written as an empty value.
  if (list === undefined) {
    throw new Error(
      'FOUNDING_TEAM_EMAILS is not set. Set it to the founding team’s addresses, separated by commas, or to an empty value.',
    );
  }
  const appOrigin = required(env, 'APP_ORIGIN', 'Set it to the origin the application is served from.');
  if (!URL.canParse(appOrigin) || new URL(appOrigin).origin !== appOrigin) {
    throw new Error(
      'APP_ORIGIN must be an origin: a scheme, a host and an optional port, with nothing after.',
    );
  }
  // NFR-SE-17 (c): the session cookie is Secure, which needs HTTPS. Plain HTTP
  // is admitted for a development machine alone.
  const { protocol, hostname } = new URL(appOrigin);
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname))) {
    throw new Error('APP_ORIGIN must use https, except on localhost.');
  }
  // The only sender yet is the local sink, which writes each message to a file
  // and sends nothing (register D70 (the three checks stand), D92). Anywhere but
  // a development machine it has to be chosen in so many words, so that no
  // deployment loses its email unnoticed: sign-in and reset answer the same
  // whether or not a message went.
  const local = ['localhost', '127.0.0.1'].includes(hostname);
  if (env.EMAIL_TRANSPORT ? env.EMAIL_TRANSPORT !== 'sink' : !local) {
    throw new Error('EMAIL_TRANSPORT must be set to sink: no other sender of email is built yet.');
  }
  // NFR-SE-19: each file of the sink holds an address and may hold a single-use
  // link. A deployment says where they go; it does not get a directory under
  // the working directory by leaving the setting out.
  if (!local && !env.EMAIL_SINK_DIRECTORY) {
    throw new Error('EMAIL_SINK_DIRECTORY is not set. Set it to the directory the email sink writes to.');
  }
  const authSecret = required(env, 'AUTH_SECRET', 'Set it to a random value of at least 32 characters.');
  if (authSecret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters.');

  const sessionIdleSeconds = wholeNumber(env, 'SESSION_IDLE_SECONDS', 7 * DAY, 1);
  const sessionRenewSeconds = wholeNumber(env, 'SESSION_RENEW_SECONDS', DAY, 1);
  const sessionMaxSeconds = wholeNumber(env, 'SESSION_MAX_SECONDS', 30 * DAY, 1);
  // FR-AU-84: a renewal comes within the period it renews, and that period
  // within the life of a session. Written otherwise, one of the three would
  // never be reached.
  if (sessionRenewSeconds > sessionIdleSeconds || sessionIdleSeconds > sessionMaxSeconds) {
    throw new Error(
      'SESSION_RENEW_SECONDS must be no more than SESSION_IDLE_SECONDS, and SESSION_IDLE_SECONDS no more than SESSION_MAX_SECONDS.',
    );
  }
  const passwordMinLength = wholeNumber(env, 'PASSWORD_MIN_LENGTH', 15, 1);
  const passwordMaxLength = wholeNumber(env, 'PASSWORD_MAX_LENGTH', 128, 1);
  // FR-AU-82: otherwise no password could be chosen at all.
  if (passwordMinLength > passwordMaxLength) {
    throw new Error('PASSWORD_MIN_LENGTH must be no more than PASSWORD_MAX_LENGTH.');
  }

  return {
    foundingTeamEmails: list
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
    appOrigin,
    databaseUrl: required(env, 'DATABASE_URL', 'Set it to the connection string of the role ekdotico_app.'),
    valkeyUrl: required(env, 'VALKEY_URL', 'Set it to the address of Valkey.'),
    authSecret,
    trustedProxyCount: wholeNumber(env, 'TRUSTED_PROXY_COUNT', 0, 0),
    sessionIdleSeconds,
    sessionRenewSeconds,
    sessionMaxSeconds,
    cookieCacheSeconds: wholeNumber(env, 'COOKIE_CACHE_SECONDS', 60, 0),
    passwordMinLength,
    passwordMaxLength,
    securityLogRetentionDays: wholeNumber(env, 'SECURITY_LOG_RETENTION_DAYS', 30, 1),
    emailSinkDirectory: env.EMAIL_SINK_DIRECTORY || '.local/mail',
    emailFrom: env.EMAIL_FROM || 'Ekdotico <no-reply@localhost>',
    limits: Object.fromEntries(
      (Object.keys(LIMITS) as LimitName[]).map((name) => [name, limit(env, name)]),
    ) as Record<LimitName, Limit>,
  };
}

let loaded: Settings | undefined;

/** The settings of this process, read once. A process checks them at start by calling `loadSettings`. */
export function settings(): Settings {
  return (loaded ??= loadSettings());
}
