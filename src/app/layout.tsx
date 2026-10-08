import '@ekdotico/domico/tokens.css';
import '@ekdotico/domico/styles.css';

import type { Metadata } from 'next';
import { Crimson_Pro, Commissioner, Fira_Code } from 'next/font/google';
import { themeInitScript } from '@ekdotico/domico/theme';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="parchment"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
