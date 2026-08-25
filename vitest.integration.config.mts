import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/integration/**/*.test.ts'],
    environment: 'node',

    // Creates a throwaway database, migrates it, and drops it afterwards.
    globalSetup: ['server/tests/setup/integration-database.ts'],

    // One disposable database is shared by every integration file, so they run
    // one at a time rather than fighting over the same rows. Revisit only when
    // the suite is slow enough to be worth a database per file.
    fileParallelism: false,

    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
