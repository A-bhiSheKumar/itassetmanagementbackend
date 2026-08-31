import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],

    // The env schema in src/config/env.ts refuses to boot without these. That
    // is the point — but tests need values before the first import, and
    // setupFiles run too late to help. MONGO_URI is overridden at runtime by
    // the in-memory replica set in tests/setup.ts.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MONGO_URI: 'mongodb://127.0.0.1:27017/itam-test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
      CORS_ORIGINS: 'http://localhost:5173',
    },
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],

    /**
     * Share one module graph across test files.
     *
     * With the default `isolate: true`, vitest re-evaluates src/ modules per
     * test file while keeping node_modules shared. That means each file gets a
     * fresh AsyncLocalStorage and a fresh `pluginsRegistered` flag, but the SAME
     * mongoose singleton — so the tenant-scope plugin gets registered once per
     * file, and models compiled in file 2 also run file 1's hook, which reads an
     * ALS instance that is always empty and throws.
     *
     * Isolation between tests comes from the afterEach truncation in setup.ts,
     * not from re-evaluating the module graph.
     */
    isolate: false,

    /**
     * Files run strictly one after another.
     *
     * These suites share one database AND one module graph (isolate: false), so
     * interleaving them lets one file's beforeAll run before another's afterAll
     * — which let the isolation suite's shared-fixture flag suppress truncation
     * for a different file, and its count assertions then saw leftover rows.
     * The symptom was three unrelated tests failing intermittently in the full
     * run while passing every time in isolation.
     */
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@': r('./src'),
      '@core': r('./src/core'),
      '@modules': r('./src/modules'),
      '@config': r('./src/config'),
      '@shared': r('./src/shared'),
    },
  },
});
