// FR-AU-82: the rules of a password, and that each refusal says which rule.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ekdotico-passwords-'));
const listFile = join(root, 'list.txt');
writeFileSync(
  listFile,
  [
    '# A list for the tests.',
    '# Two lines of heading.',
    'known-password-one',
    'Known Password Two',
    '#hash-begins-this-one',
  ].join('\n'),
);

// The module reads its settings, and the list, once: each test loads it afresh.
async function load(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({
    settings: () => ({
      passwordMinLength: 15,
      passwordMaxLength: 128,
      passwordListFile: listFile,
      ...settings,
    }),
  }));
  return (await import('../../src/lib/password-rules.ts')).checkPassword;
}

afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EMAIL = 'ada.lovelace@example.com';
const GOOD = 'a long and private phrase';

describe('the length of a password', () => {
  it('is at least 15 characters and at most 128', async () => {
    const check = await load();
    expect(check('a'.repeat(14) + '!', EMAIL)).toBeNull();
    expect(check('x'.repeat(7) + 'y'.repeat(7), EMAIL)).toMatch(/at least 15 characters/);
    expect(check('', EMAIL)).toMatch(/at least 15 characters/);
    expect(check('xy'.repeat(64), EMAIL)).toBeNull();
    expect(check('xy'.repeat(64) + 'z', EMAIL)).toMatch(/at most 128 characters/);
  });

  it('follows the two settings', async () => {
    const check = await load({ passwordMinLength: 20, passwordMaxLength: 30 });
    expect(check('nineteen characters', EMAIL)).toMatch(/at least 20 characters/);
    expect(check('twenty characters ok', EMAIL)).toBeNull();
    expect(check('x'.repeat(31), EMAIL)).toMatch(/at most 30 characters/);
  });

  it('counts a character as one code point, not as its two halves', async () => {
    const check = await load();
    // 15 characters outside the basic plane: 30 units of UTF-16.
    expect(check('𝒜'.repeat(15), EMAIL)).toBeNull();
    expect(check('𝒜'.repeat(14), EMAIL)).toMatch(/at least 15 characters/);
    expect(check('𝒜'.repeat(128), EMAIL)).toBeNull();
    expect(check('𝒜'.repeat(129), EMAIL)).toMatch(/at most 128 characters/);
  });
});

describe('the characters of a password', () => {
  it('accepts every printing character and the space, and asks for no mixture', async () => {
    const check = await load();
    expect(check('               ', EMAIL)).toBeNull();
    expect(check('lower case only and spaces', EMAIL)).toBeNull();
    expect(check('κωδικός πρόσβασης μου', EMAIL)).toBeNull();
    expect(check('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', EMAIL)).toBeNull();
    expect(check('密码密码密码密码密码密码密码密', EMAIL)).toBeNull();
  });
});

describe('a password that contains the address or its local part', () => {
  it('is refused, and told why', async () => {
    const check = await load();
    expect(check(`my ${EMAIL} password`, EMAIL)).toMatch(/cannot contain your email address/);
    expect(check('ada.lovelace is my name', EMAIL)).toMatch(/cannot contain your email address/);
  });

  it('without regard to case, in the password or in the address', async () => {
    const check = await load();
    expect(check('ADA.LOVELACE is my name', EMAIL)).toMatch(/cannot contain/);
    expect(check('ada.lovelace is my name', 'Ada.Lovelace@Example.com')).toMatch(/cannot contain/);
  });

  it('but a local part of fewer than four characters is not looked for', async () => {
    const check = await load();
    expect(check('a balanced password', 'bal@example.com')).toBeNull();
    expect(check('a balanced password', 'bala@example.com')).toMatch(/cannot contain/);
    // The whole address still is, however short its local part.
    expect(check('with al@example.com inside', 'al@example.com')).toMatch(/cannot contain/);
  });

  it('takes the local part to end at the last @', async () => {
    const check = await load();
    expect(check('"odd@local" is in here', '"odd@local"@example.com')).toMatch(/cannot contain/);
  });
});

describe('a password on the list', () => {
  it('is refused, and told why', async () => {
    const check = await load();
    expect(check('known-password-one', EMAIL)).toMatch(/on a list of commonly used and known-compromised/);
    expect(check('known-password-one!', EMAIL)).toBeNull();
  });

  it('without regard to case', async () => {
    const check = await load();
    expect(check('KNOWN-password-ONE', EMAIL)).toMatch(/on a list/);
    expect(check('known password two', EMAIL)).toMatch(/on a list/);
  });

  it('reads the heading of the file as no password, and a later # as one', async () => {
    const check = await load();
    expect(check('# A list for the tests.', EMAIL)).toBeNull();
    expect(check('#hash-begins-this-one', EMAIL)).toMatch(/on a list/);
  });

  it('is checked after the length, so a short one is told of its length', async () => {
    const check = await load({ passwordMinLength: 30 });
    expect(check('known-password-one', EMAIL)).toMatch(/at least 30 characters/);
  });

  it('refuses every password where the list cannot be read, and names neither', async () => {
    const check = await load({ passwordListFile: join(root, 'absent.txt') });
    let thrown: unknown;
    try {
      check(GOOD, EMAIL);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('The list of known passwords could not be read.');
    expect((thrown as Error).message).not.toContain(GOOD);
  });

  it('reads the file shipped with the application', async () => {
    const check = await load({ passwordListFile: 'data/common-passwords.txt' });
    expect(check('passwordpassword', EMAIL)).toMatch(/on a list/);
    expect(check(GOOD, EMAIL)).toBeNull();
  });
});

describe('the statements', () => {
  it('say which rule was not met, one each, and never repeat the password', async () => {
    const check = await load();
    const refusals = [
      check('too short', EMAIL),
      check('x'.repeat(129), EMAIL),
      check(`${EMAIL} and more`, EMAIL),
      check('known-password-one', EMAIL),
    ];
    expect(new Set(refusals).size).toBe(4);
    for (const refusal of refusals) expect(refusal).toMatch(/Choose a (longer|shorter|different) one\.$/);
    expect(check('known-password-one', EMAIL)).not.toContain('known-password-one');
  });
});

// The identity library hashes the compatibility form (NFKC) of a password, so
// the rules judge that form: a full-width spelling is the password it becomes.
describe('a password as it is stored', () => {
  it('refuses the full-width spelling of a listed password', async () => {
    const check = await load();
    expect(check('ｋｎｏｗｎ-ｐａｓｓｗｏｒｄ-ｏｎｅ', EMAIL)).toMatch(/on a list/);
  });

  it('refuses the full-width spelling of the address', async () => {
    const check = await load();
    expect(check('ａｄａ.ｌｏｖｅｌａｃｅ and more words', EMAIL)).toMatch(
      /cannot contain your email address/,
    );
  });

  it('counts the characters of the stored form', async () => {
    const check = await load({ passwordMinLength: 3, passwordMaxLength: 3 });
    // One ligature that the stored form writes as three letters.
    expect(check('ﬃ', EMAIL)).toBeNull();
  });
});
