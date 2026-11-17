// UI audit F15 and F02: the appearance cookies and the sentence before the invite form, both approved by
// the owner on 17 November 2026 (ui-appearance-cookie = "cookie", ui-invite-sentence = "approve").
// The texts are written out here and not taken from the code under test.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appearanceAttributes, appearanceState } from '@ekdotico/domico/theme/server';

const store = (jar: Record<string, string>) => ({
  get: (name: string) => (name in jar ? { value: jar[name]! } : undefined),
});

describe('the appearance cookies', () => {
  it('put no attribute on the page when nothing was chosen: Parchment, and the mode of the device', () => {
    expect({ ...appearanceAttributes(store({})) }).toEqual({});
    expect(appearanceState(store({}))).toEqual({ theme: 'parchment', mode: 'auto' });
  });

  it('put the stored choice on the page, and leave Auto as the absence of a mode', () => {
    expect({ ...appearanceAttributes(store({ 'ekd-theme': 'sepia', 'ekd-mode': 'dark' })) }).toEqual({
      'data-theme': 'sepia',
      'data-mode': 'dark',
    });
    expect({ ...appearanceAttributes(store({ 'ekd-theme': 'mono', 'ekd-mode': 'auto' })) }).toEqual({
      'data-theme': 'mono',
    });
    expect({ ...appearanceAttributes(store({ 'ekd-theme': 'neon', 'ekd-mode': 'blue' })) }).toEqual({});
    expect(appearanceState(store({ 'ekd-theme': 'library', 'ekd-mode': 'light' }))).toEqual({
      theme: 'library',
      mode: 'light',
    });
  });

  it('are read by the root layout, which hardcodes no theme', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(layout).toContain('{...appearanceAttributes(store)}');
    expect(layout).toContain('<AppearanceProvider value={appearanceState(store)}>');
    expect(layout).not.toMatch(/data-theme=/);
  });

  it('are kept by a sign-out, which clears the session cookies and names no other', () => {
    const signIn = readFileSync('src/lib/auth/sign-in.ts', 'utf8');
    expect(signIn.slice(signIn.indexOf("'/sign-out'"))).toContain('deleteSessionCookie(ctx)');
    for (const file of ['src/lib/auth/sign-in.ts', 'src/lib/auth/session-end.ts', 'src/proxy.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/ekd-theme|ekd-mode|Clear-Site-Data/);
    }
  });
});

describe('the sentence before the invite form', () => {
  it('is the approved sentence, whole, before the form, and names no address', () => {
    const source = readFileSync('src/app/(app)/documents/[id]/sharing/sharing-settings.tsx', 'utf8');
    expect(source).toContain(
      '<p className={styles.text}>The person you invite needs an Ekdotico account first.</p>',
    );
    expect(source.indexOf('needs an Ekdotico account first')).toBeLessThan(
      source.indexOf('id="invite-emails"'),
    );
  });
});
