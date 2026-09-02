import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // server/migrations is deliberate: a merged migration is never edited, so no
    // tool may rewrite one. See the migrations section of the README.
    ignores: [
      'node_modules/**',
      'client/node_modules/**',
      'client/dist/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'server/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The server, the migration tooling, the test suite and the scripts all run on
  // Node.
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // And since LMS 401 the React client runs in a browser, which is the block the
  // note above predicted. Scoped to client/** so that `window` and `document` are
  // defined exactly where they exist and nowhere else — a server file that reached
  // for one would still be an error, which is the point of scoping it.
  {
    files: ['client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },

  // Must stay last. Turns off the rules that would argue with Prettier about
  // layout, so the two tools never disagree about the same line.
  prettier,
);
