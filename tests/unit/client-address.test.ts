// NFR-SE-07: the address a session-less request is limited by must not be one
// the client chooses. The addresses are those reserved for documentation.
import { describe, expect, it } from 'vitest';

// Obviously fake values: the settings module refuses to load without them.
process.env.FOUNDING_TEAM_EMAILS ??= '';
process.env.APP_ORIGIN ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake';
process.env.VALKEY_URL ??= 'redis://localhost:6379';
process.env.AUTH_SECRET ??= 'a-test-secret-of-at-least-thirty-two-characters';
process.env.TRUSTED_PROXY_COUNT = '2';

const { UNKNOWN_ADDRESS, addressBehind, clientAddress } = await import('../../src/lib/client-address.ts');

const forwarded = (...lines: string[]) => {
  const headers = new Headers();
  for (const line of lines) headers.append('x-forwarded-for', line);
  return headers;
};

describe('addressBehind, with no trusted proxy', () => {
  // Next.js 16.4.0 keeps a client's X-Forwarded-For and fills it from the
  // socket only where there is none, so no value of it can be believed.
  it.each([
    ['a single entry, which may be the socket’s or the client’s', forwarded('203.0.113.9')],
    ['several entries', forwarded('203.0.113.9, 198.51.100.7')],
    ['no header', new Headers()],
    ['another header a client can set', new Headers({ 'x-real-ip': '203.0.113.9' })],
  ])('puts every request in one bucket: %s', (_case, headers) => {
    expect(addressBehind(headers, 0)).toBe(UNKNOWN_ADDRESS);
  });
});

describe('addressBehind, with trusted proxies', () => {
  it('takes the entry the one proxy wrote', () => {
    expect(addressBehind(forwarded('198.51.100.7'), 1)).toBe('198.51.100.7');
  });

  it('ignores every entry to the left, which the client wrote', () => {
    expect(addressBehind(forwarded('203.0.113.9, 192.0.2.44, 198.51.100.7'), 1)).toBe('198.51.100.7');
  });

  it('takes the n-th entry from the right for n proxies', () => {
    const headers = forwarded('203.0.113.9, 198.51.100.7, 10.0.0.2, 10.0.0.3');
    expect(addressBehind(headers, 2)).toBe('10.0.0.2');
    expect(addressBehind(headers, 3)).toBe('198.51.100.7');
  });

  it('reads repeated header lines as one list', () => {
    expect(addressBehind(forwarded('203.0.113.9', '198.51.100.7', '10.0.0.2'), 2)).toBe('198.51.100.7');
  });

  it('does not fall back to a client’s entry where there are fewer entries than proxies', () => {
    expect(addressBehind(forwarded('203.0.113.9'), 2)).toBe(UNKNOWN_ADDRESS);
    expect(addressBehind(forwarded('203.0.113.9, 198.51.100.7'), 3)).toBe(UNKNOWN_ADDRESS);
  });

  it('trims the entry and writes an IPv4-mapped address as IPv4', () => {
    expect(addressBehind(forwarded('  198.51.100.7  '), 1)).toBe('198.51.100.7');
    expect(addressBehind(forwarded('::ffff:198.51.100.7'), 1)).toBe('198.51.100.7');
    expect(addressBehind(forwarded('::FFFF:198.51.100.7'), 1)).toBe('198.51.100.7');
  });

  it('keeps an IPv6 address, in lower case', () => {
    expect(addressBehind(forwarded('2001:DB8::1'), 1)).toBe('2001:db8::1');
  });

  it.each([
    ['no header', new Headers()],
    ['an empty header', forwarded('')],
    ['an empty last entry', forwarded('198.51.100.7,')],
    ['a word', forwarded('unknown')],
    ['a host name', forwarded('client.example')],
    ['an address with a port', forwarded('198.51.100.7:4711')],
    ['a number out of range', forwarded('198.51.100.700')],
    ['a mapped prefix with nothing valid after it', forwarded('::ffff:example')],
    ['text made to look like a key', forwarded('198.51.100.7 limit:*')],
  ])('puts a request in the one bucket where the entry is not an address: %s', (_case, headers) => {
    expect(addressBehind(headers, 1)).toBe(UNKNOWN_ADDRESS);
  });

  it('never reads X-Real-IP', () => {
    expect(addressBehind(new Headers({ 'x-real-ip': '203.0.113.9' }), 1)).toBe(UNKNOWN_ADDRESS);
  });
});

describe('clientAddress', () => {
  it('uses the number of proxies in the settings (TRUSTED_PROXY_COUNT)', () => {
    expect(clientAddress(forwarded('203.0.113.9, 198.51.100.7, 10.0.0.2'))).toBe('198.51.100.7');
  });
});
