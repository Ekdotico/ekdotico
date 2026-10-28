// What scripts/backup.ts, scripts/backup-restore.ts and scripts/rotate-auth-secret.ts share: how they start
// pg_dump, psql and pg_restore, how they say a fault, and which hosts are local. A fault is said by its class
// and never by what the tool wrote: a line of psql or pg_dump names the host, the port and the role, and a
// line of the SDK names an address (docs/plan/slice-27.md, S27-11).
import { spawn } from 'node:child_process';
import { EnvelopeError } from './backup-envelope.ts';

/** A fault of a tool this job started. Its message is made here from fixed words and numbers, and is safe to print. */
export class ToolFault extends Error {
  name = 'ToolFault';
}

/** Hosts that are this machine: a connection to one needs no TLS, and an object store there may be plain http. */
export const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];
export const TLS_MODES = ['require', 'verify-ca', 'verify-full'];

/**
 * The class of a fault from what a tool wrote to stderr, in words of ours: a connection that failed, the SQLSTATE of
 * an error (psql is run with VERBOSITY=sqlstate), a refused privilege. Nothing of the text is repeated.
 */
export function faultClass(stderr: string): string {
  const state = /ERROR:\s+([0-9A-Z]{5})\s*$/m.exec(stderr)?.[1];
  if (state) return `SQLSTATE ${state}`;
  if (
    /connection to server|could not connect|could not translate host|timeout expired|server closed|SSL|FATAL/i.test(
      stderr,
    )
  )
    return 'connection fault';
  if (/permission denied/i.test(stderr)) return 'permission denied';
  return '';
}

/** Runs a tool with exactly this environment, and resolves with its stdout. A failure says the exit status and its class. */
export function run(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.once('error', (error) =>
      reject(
        new ToolFault(
          `${command} could not be started (${(error as NodeJS.ErrnoException).code ?? 'fault'})`,
        ),
      ),
    );
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(toolFailed(command, code, err))));
  });
}

export function toolFailed(command: string, code: number | null, stderr: string): ToolFault {
  const kind = faultClass(stderr);
  return new ToolFault(`${command} failed (exit ${code}${kind ? `, ${kind}` : ''})`);
}

/**
 * What is said of an error that is not a refusal: its class, and a code or an HTTP status where it has one. Never its
 * message, which may name a host, a role or an address. Faults of ours say what they say.
 */
export function describeError(error: unknown): string {
  if (error instanceof ToolFault || error instanceof EnvelopeError) return `${error.name}: ${error.message}`;
  if (error instanceof Error) {
    const e = error as { code?: unknown; $metadata?: { httpStatusCode?: number } };
    const code = typeof e.code === 'string' ? e.code : e.$metadata?.httpStatusCode;
    return code === undefined ? error.name : `${error.name} ${code}`;
  }
  return 'Error';
}

/** The environment that points a libpq tool at a database, from the parts of its URL. Password in the environment, never in an argument. */
export function connectionEnv(url: URL, extra: Record<string, string> = {}): Record<string, string> {
  const sslmode = url.searchParams.get('sslmode');
  const rootCert = url.searchParams.get('sslrootcert');
  return {
    PATH: process.env.PATH ?? '',
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    // A path to a certificate of the authority, which is not a secret; the server's certificate is checked against it with verify-ca or verify-full.
    ...(rootCert ? { PGSSLROOTCERT: rootCert } : {}),
    PGCONNECT_TIMEOUT: '15',
    ...extra,
  };
}

/** Away from this machine a connection must use TLS. */
export function tlsOrLocal(url: URL): boolean {
  const mode = url.searchParams.get('sslmode');
  return LOCAL.includes(url.hostname) || (mode !== null && TLS_MODES.includes(mode));
}
