import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/integration/**/*.test.ts'],
    environment: 'node',

    // Migrates one template database, and drops it and every copy afterwards.
    globalSetup: ['server/tests/setup/integration-database.ts'],

    /**
     * Files run in parallel, each against a database of its own.
     *
     * They used to share one database and so had to run one at a time, which was most
     * of what the suite cost — the work is a few hundred milliseconds a test and almost
     * none of it is the database's. server/tests/setup/test-database.ts gives each file
     * a copy of the migrated template instead, so nothing is shared and nothing has to
     * queue.
     */

    testTimeout: 30_000,

    // Copying a database is about a second, and it happens before the first test of
    // every file, inside this hook.
    hookTimeout: 120_000,
  },
});
