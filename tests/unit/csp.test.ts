// The Content-Security-Policy as text (src/lib/csp.ts; the owner's decision of
// 9 October 2026: no inline script, no remote origin, inline style attributes
// allowed, framing denied), and where next.config.ts and the proxy put it.
// That every response of the running application carries it is
// tests/e2e/headers.spec.ts.
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import config from '../../next.config.ts';
import {
  COMPANION_HEADERS,
  ISOLATION_HEADERS,
  NONCE_HEADER,
  STATIC_POLICY,
  newNonce,
  pagePolicy,
} from '../../src/lib/csp.ts';

/** The directives of a policy, by name. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split('; ').map((directive) => {
      const [name, ...sources] = directive.split(' ');
      return [name!, sources];
    }),
  );
}

const NONCE = 'bm9uY2Utb2YtYS10ZXN0IQ==';
const production = pagePolicy(NONCE, { development: false, local: false });
const local = pagePolicy(NONCE, { development: false, local: true });
const development = pagePolicy(NONCE, { development: true, local: true });

// The owner's decision of 20 October 2026 (S19-4): the policy of a page names the one origin of the
// object store in `img-src` where the application has one, configured for each environment, and
// nothing broader; and the rest of the policy is the same with it as without.
describe('the policy of a page where the application stores images (S19-4)', () => {
  const SPACES = 'https://ekdotico-images.fra1.digitaloceanspaces.com';
  const MINIO = 'http://localhost:9000';

  it.each([SPACES, MINIO])(
    'names %s in img-src, after its own origin, and in no other directive',
    (origin) => {
      const policy = pagePolicy(NONCE, { development: false, local: false, imageOrigin: origin });
      const all = directives(policy);
      expect(all['img-src']).toEqual(["'self'", origin]);
      for (const [name, sources] of Object.entries(all)) {
        if (name !== 'img-src') expect(sources, name).not.toContain(origin);
      }
      expect(policy).toContain(` img-src 'self' ${origin};`);
    },
  );

  it('is the policy without it, word for word, in every other directive', () => {
    for (const options of [
      { development: false, local: false },
      { development: false, local: true },
      { development: true, local: true },
    ]) {
      const without = directives(pagePolicy(NONCE, options));
      const withOrigin = directives(pagePolicy(NONCE, { ...options, imageOrigin: SPACES }));
      expect({ ...withOrigin, 'img-src': 0 }).toEqual({ ...without, 'img-src': 0 });
      expect(without['img-src']).toEqual(["'self'"]);
    }
  });

  it('holds that origin and nothing broader: no wildcard, scheme, path, list or host that is not the store’s', () => {
    const sources = directives(pagePolicy(NONCE, { development: false, local: false, imageOrigin: SPACES }))[
      'img-src'
    ]!;
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source).not.toMatch(/\*/);
      expect(['https:', 'http:', 'data:', 'blob:', 'filesystem:']).not.toContain(source);
    }
    expect(
      directives(pagePolicy(NONCE, { development: false, local: false, imageOrigin: MINIO }))['connect-src'],
    ).toEqual(["'self'"]);
  });

  it.each([
    '*',
    'https:',
    'data:',
    'blob:',
    '*.digitaloceanspaces.com',
    'https://*.digitaloceanspaces.com',
    `${SPACES}/images`,
    `${SPACES}/`,
    `${SPACES} https://evil.example`,
    `${SPACES}; script-src *`,
    `${SPACES}\n`,
    "'unsafe-inline'",
    'https://user@host.example',
    'ftp://host.example',
    '',
  ])(
    'refuses %j as the origin of the store, so that a value that is not an origin cannot widen it',
    (given) => {
      expect(() => pagePolicy(NONCE, { development: false, local: false, imageOrigin: given })).toThrow(
        'The origin of the image store is not an origin',
      );
    },
  );
});

describe('the policy of a page', () => {
  it('is this, word for word, in production', () => {
    expect(production).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'nonce-${NONCE}'; style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`,
    );
  });

  it.each([
    ['production', production],
    ['a production build on localhost', local],
  ])('admits no inline script, no evaluated text and no remote origin, in %s', (_, policy) => {
    const all = directives(policy);
    expect(all['script-src']).toEqual(["'self'", `'nonce-${NONCE}'`]);
    // Not `'strict-dynamic'`: under it a script that runs may load one of any origin (src/lib/csp.ts).
    expect(policy).not.toContain('strict-dynamic');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('unsafe-hashes');
    // The one `'unsafe-inline'` is that of the `style` attribute, which the owner allowed.
    expect(Object.entries(all).filter(([, sources]) => sources.includes("'unsafe-inline'"))).toEqual([
      ['style-src-attr', ["'unsafe-inline'"]],
    ]);
    // No source that is an origin, a scheme or a wildcard, in any directive.
    for (const [name, sources] of Object.entries(all)) {
      for (const source of sources) {
        expect(source, name).toMatch(/^'(self|none|unsafe-inline|nonce-[A-Za-z0-9+/]+={0,2})'$/);
      }
    }
    expect(policy).not.toMatch(/\*|https?:|wss?:|data:|blob:|filesystem:/);
  });

  it('denies framing, plug-ins, a base address and a form sent elsewhere', () => {
    const all = directives(production);
    expect(all['frame-ancestors']).toEqual(["'none'"]);
    expect(all['frame-src']).toEqual(["'none'"]);
    expect(all['object-src']).toEqual(["'none'"]);
    expect(all['base-uri']).toEqual(["'none'"]);
    expect(all['form-action']).toEqual(["'self'"]);
    expect(all['default-src']).toEqual(["'self'"]);
    expect(all['connect-src']).toEqual(["'self'"]);
  });

  it('asks for HTTPS everywhere but on localhost', () => {
    expect(directives(production)).toHaveProperty('upgrade-insecure-requests');
    expect(directives(local)).not.toHaveProperty('upgrade-insecure-requests');
    expect(local).toBe(production.replace('; upgrade-insecure-requests', ''));
  });

  it('admits what the development server needs, there alone', () => {
    const all = directives(development);
    expect(all['script-src']).toEqual(["'self'", `'nonce-${NONCE}'`, "'unsafe-eval'"]);
    expect(all['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(all['script-src']).not.toContain("'unsafe-inline'");
  });

  it('holds a nonce that no two requests share', () => {
    const nonces = Array.from({ length: 1000 }, newNonce);
    expect(new Set(nonces).size).toBe(1000);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('the policy of everything that is no page', () => {
  it('admits nothing', () => {
    expect(STATIC_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

// Written out, and not taken from the code under test.
const PERMISSIONS =
  'clipboard-write=(self), accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-read=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), storage-access=(), usb=(), window-management=(), xr-spatial-tracking=()';

describe('the features of the browser a page is granted', () => {
  it('are the one the application uses, for its own origin, and no other', () => {
    const granted = PERMISSIONS.split(', ').filter((each) => !each.endsWith('=()'));
    // The two buttons that copy (`navigator.clipboard.writeText`); nothing reads the clipboard.
    expect(granted).toEqual(['clipboard-write=(self)']);
    expect(PERMISSIONS).not.toContain('*');
    expect(ISOLATION_HEADERS.map(({ key }) => key)).toEqual([
      'Cross-Origin-Opener-Policy',
      'Cross-Origin-Resource-Policy',
      'Permissions-Policy',
    ]);
  });
});

describe('the headers of every response (next.config.ts)', () => {
  it('are the policy that admits nothing and the six beside it, on every path', async () => {
    const [every] = await config.headers!();
    expect(every).toEqual({
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: PERMISSIONS },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    });
    expect(COMPANION_HEADERS).toEqual(every!.headers.slice(1));
    // HSTS is the decision of the deployment's proxy, which ends TLS (docs/operations/deployment.md).
    expect(JSON.stringify(await config.headers!())).not.toMatch(/strict-transport-security|report-(uri|to)/i);
  });
});

describe('the proxy, on a request it passes on', () => {
  const settings: { appOrigin: string; limits: object; imageStorage?: { origin: string } } = {
    appOrigin: 'https://app.example.test',
    limits: {},
  };
  /** The proxy, with nothing behind it: every path here is one it passes on without a session. */
  async function passed(path: string, headers: Record<string, string> = {}) {
    vi.resetModules();
    vi.doMock('../../src/lib/settings.ts', () => ({ settings: () => settings }));
    vi.doMock('../../src/lib/rate-limit.ts', () => ({ takeLimit: async () => ({ ok: true }) }));
    vi.doMock('../../src/lib/auth/session.ts', () => ({ validateSession: async () => ({ session: null }) }));
    vi.doMock('../../src/lib/auth/auth.ts', () => ({ IDENTITY_BASE_PATH: '/api/auth' }));
    vi.doMock('../../src/lib/auth/route-answers.ts', () => ({ FORBIDDEN: '', notAdmitted: vi.fn() }));
    vi.doMock('../../src/lib/security-log.ts', () => ({ securityLog: async () => {} }));
    const { proxy } = await import('../../src/proxy.ts');
    return proxy(new NextRequest(`https://app.example.test${path}`, { headers }));
  }
  /** What Next.js is told to put in place of the request's headers (\`NextResponse.next({ request })\`). */
  const toThePage = (response: Response, name: string) =>
    response.headers.get(`x-middleware-request-${name.toLowerCase()}`);

  it('gives a page a policy with a nonce of its own, on the response and on the request Next.js reads', async () => {
    const first = await passed('/sign-in');
    const second = await passed('/sign-in');
    const policy = first.headers.get('Content-Security-Policy')!;
    const nonce = toThePage(first, NONCE_HEADER)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policy).toBe(pagePolicy(nonce, { development: false, local: false }));
    expect(toThePage(first, 'Content-Security-Policy')).toBe(policy);
    expect(toThePage(second, NONCE_HEADER)).not.toBe(nonce);
    expect(second.headers.get('Content-Security-Policy')).not.toBe(policy);
  });

  // S19-4: the origin comes from the settings of the environment, and from nothing else.
  it('names the origin of the object store the settings give, in img-src, and none where they give none', async () => {
    try {
      settings.imageStorage = { origin: 'https://ekdotico-images.fra1.digitaloceanspaces.com' };
      const withStore = (await passed('/sign-in')).headers.get('Content-Security-Policy')!;
      expect(directives(withStore)['img-src']).toEqual([
        "'self'",
        'https://ekdotico-images.fra1.digitaloceanspaces.com',
      ]);
      // Nothing a request carries changes it.
      const asked = (
        await passed('/sign-in', { 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' })
      ).headers.get('Content-Security-Policy')!;
      expect(directives(asked)['img-src']).toEqual(directives(withStore)['img-src']);
      delete settings.imageStorage;
      const without = (await passed('/sign-in')).headers.get('Content-Security-Policy')!;
      expect(directives(without)['img-src']).toEqual(["'self'"]);
    } finally {
      delete settings.imageStorage;
    }
  });

  it('never takes a nonce or a policy from the client', async () => {
    const sent = { [NONCE_HEADER]: 'chosen', 'Content-Security-Policy': "script-src 'nonce-chosen'" };
    const page = await passed('/sign-in', sent);
    expect(toThePage(page, NONCE_HEADER)).not.toBe('chosen');
    expect(page.headers.get('Content-Security-Policy')).not.toContain('chosen');
    expect(toThePage(page, 'Content-Security-Policy')).not.toContain('chosen');
    // To a route and to a file of the build, neither is passed at all.
    for (const path of ['/api/health', '/_next/static/chunks/a.js']) {
      const other = await passed(path, sent);
      expect(other.headers.get('x-middleware-override-headers')).toBeNull();
      expect(toThePage(other, NONCE_HEADER)).toBeNull();
      expect(toThePage(other, 'Content-Security-Policy')).toBeNull();
    }
  });

  it('leaves a route and a file of the build the policy that admits nothing', async () => {
    for (const path of ['/api/health', '/api/sign-up', '/_next/static/chunks/a.js']) {
      // No policy of the proxy's: the one of next.config.ts stands.
      expect((await passed(path)).headers.get('Content-Security-Policy'), path).toBeNull();
    }
  });
});
