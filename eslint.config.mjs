import next from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// Contract IC-49: the application obtains the port from one module and from nowhere else.
const istoricoPort = {
  regex: 'istorico/port(\\.ts)?$',
  message: 'Import the Istorico port from src/lib/istorico/index.ts (contract IC-49).',
};

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
    ignores: ['src/lib/istorico/index.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [istoricoPort] }] },
  },
  {
    // NFR-SE-04, FR-ED-39 (the owner's decision of 8 October 2026): a route of
    // a document reaches the database only through src/lib/documents, where
    // the request is authorised first. A block replaces the rule of the block
    // above for these files, so the port's pattern is repeated here. The rule
    // sees an import written at the top of a file, not `import()`.
    files: ['src/app/api/documents/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            istoricoPort,
            {
              regex: '(lib/db(\\.ts)?$|generated/prisma|^@prisma/)',
              message:
                'A route of a document does not import the database client: go through src/lib/documents (NFR-SE-04, FR-ED-39).',
            },
          ],
        },
      ],
    },
  },
];

export default config;
