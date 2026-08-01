import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
      '@tests': path.resolve(root, './tests'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/helpers/global-setup.ts'],
    setupFiles: ['./tests/helpers/setup.ts'],
    // Forks give each test file a clean module registry, which matters because
    // several modules memoise a Mongo client / config snapshot at module scope.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Vitest's own clean step races with the per-worker temp files once the
      // suite is large enough to fan out across many forks, so the directory is
      // removed by the npm script instead.
      clean: false,
      cleanOnRerun: false,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        // Presentational shells with no branching logic.
        'src/app/**/layout.tsx',
        'src/app/**/page.tsx',
        'src/app/**/error.tsx',
        'src/app/**/not-found.tsx',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
