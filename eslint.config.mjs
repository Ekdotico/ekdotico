import next from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
      'src/generated/**',
    ],
  },
  ...next,
  ...nextTypescript,
  {
    // NFR-SE-02, NFR-SE-19: draft mode sends the build's revalidation
    // identifier to the browser as a cookie, and a request that carries that
    // identifier is not passed through proxy.ts (docs/operations/deployment.md).
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[imported.name='draftMode']",
          message: 'Draft mode is not used: it discloses the identifier that lets a request skip proxy.ts.',
        },
      ],
    },
  },
  {
    // Contract IC-49: the application obtains the port from one module and from nowhere else.
    ignores: ['src/lib/istorico/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: 'istorico/port(\\.ts)?$',
              message: 'Import the Istorico port from src/lib/istorico/index.ts (contract IC-49).',
            },
          ],
        },
      ],
    },
  },
];

export default config;
