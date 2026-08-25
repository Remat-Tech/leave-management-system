import { defineConfig } from 'vitest/config';

// Unit tests. No database, no network, no fixtures to load. If a test here
// needs any of those, it belongs in server/tests/integration instead.
export default defineConfig({
  test: {
    include: ['server/tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
