import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
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
