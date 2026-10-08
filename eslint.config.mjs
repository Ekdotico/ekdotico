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
