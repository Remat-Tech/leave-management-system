import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // server/migrations is deliberate: a merged migration is never edited, so no
    // tool may rewrite one. See the migrations section of the README.
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', 'server/migrations/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Must stay last. Turns off the rules that would argue with Prettier about
  // layout, so the two tools never disagree about the same line.
  prettier,
);
