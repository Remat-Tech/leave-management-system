import { defineConfig } from 'vitest/config';

/**
 * Runs the walkthroughs in server/tests/walkthrough.
 *
 * Not a test suite. They are narrated runs against a real database, for reading
 * rather than for a build, and this is a separate config precisely so that
 * `npm test` and `npm run test:int` never pick them up: they take half a minute,
 * one of them wants Mailpit running, and both are written to print rather than
 * to assert.
 *
 *   npm run mail          # in another terminal, for the sign in one only
 *   npm run walkthrough   # both
 *   npm run chart         # only the organisation chart, which needs no mail
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
