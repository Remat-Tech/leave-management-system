import { defineConfig } from 'vitest/config';

/**
 * Runs the sign in walkthrough in server/tests/walkthrough.
 *
 * Not a test suite. It is a narrated run of LMS 109 and LMS 110 against a real
 * database and real mail, for reading rather than for a build, and it is a
 * separate config precisely so that `npm test` and `npm run test:int` never pick
 * it up: it wants Mailpit running, it takes half a minute, and it is written to
 * print rather than to assert.
 *
 *   npm run mail                                       # in another terminal
 *   npx vitest run --config vitest.walkthrough.mts
 */
export default defineConfig({
  test: {
    include: ['server/tests/walkthrough/*.ts'],
    environment: 'node',

    // It builds and drops a database of its own, and every step depends on the
    // one before it.
    fileParallelism: false,
    sequence: { concurrent: false },

    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
