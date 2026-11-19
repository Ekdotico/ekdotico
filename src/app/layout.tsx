import '@ekdotico/domico/tokens.css';
import '@ekdotico/domico/styles.css';
import './scale.css';
import '@ekdotico/domico/styles/frame.css';

import type { Metadata } from 'next';
import { Crimson_Pro, Commissioner, Fira_Code } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import { AppearanceProvider, themeInitScript } from '@ekdotico/domico/theme';
import { appearanceAttributes, appearanceState } from '@ekdotico/domico/theme/server';
import { NONCE_HEADER } from '../lib/csp.ts';

// next/font accepts only literal options, so these restate `fontConfig` from
// @ekdotico/domico/fonts rather than passing it.
const serif = Crimson_Pro({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-crimson-pro',
  style: ['normal', 'italic'],
});
const sans = Commissioner({ subsets: ['latin'], display: 'swap', variable: '--font-commissioner' });
const mono = Fira_Code({ subsets: ['latin'], display: 'swap', variable: '--font-fira-code' });

// Each page names itself, and the product's name follows (WCAG 2.2, 2.4.2).
export const metadata: Metadata = { title: { default: 'Ekdotico', template: '%s – Ekdotico' } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The nonce of this request (src/proxy.ts, src/lib/csp.ts). Reading it makes
  // every page one that is rendered for its request, which a nonce needs: a
  // page rendered when the application is built has no request to take one from.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  // UI audit F15: the reader's theme and mode, from the design system's first-party preference cookies
  // (`ekd-theme`, `ekd-mode`: the owner's answer ui-appearance-cookie, 17 November 2026). With no cookie
  // there is no attribute: Parchment, and the mode of the device.
  const store = await cookies();
  return (
    <html
      lang="en"
      {...appearanceAttributes(store)}
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* The design package's own way under a strict policy: "the script tag needs the request nonce". */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body>
        <AppearanceProvider value={appearanceState(store)}>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
