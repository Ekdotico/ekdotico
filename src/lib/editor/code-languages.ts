// The languages a code block may be set to (FR-ED-03), and the rule that holds the attribute to them. Nothing here is of
// React or Next.js: the editor's code block (src/app/(app)/documents/[id]/extensions.tsx) and the Markdown draft
// export (src/lib/export/read.ts) both read it, so that the language of a block is one of these in the browser and in
// the file, whatever the stored attribute holds.

// "The languages in lowlight's common set" (register D46), each under the name
// its own project writes. `plaintext` is first, and is what a new block has.
export const LANGUAGES: Record<string, string> = {
  plaintext: 'Plain text',
  arduino: 'Arduino',
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  graphql: 'GraphQL',
  ini: 'INI and TOML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  perl: 'Perl',
  php: 'PHP',
  'php-template': 'PHP template',
  python: 'Python',
  'python-repl': 'Python REPL',
  r: 'R',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  vbnet: 'Visual Basic .NET',
  wasm: 'WebAssembly',
  xml: 'HTML and XML',
  yaml: 'YAML',
};

/** The language as one of the list, whatever the attribute holds. */
export const codeLanguage = (given: unknown): string =>
  typeof given === 'string' && Object.hasOwn(LANGUAGES, given) ? given : 'plaintext';
