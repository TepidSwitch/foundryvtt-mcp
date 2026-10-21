import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      FOUNDRY_URL: 'http://localhost:30000',
      LOG_LEVEL: 'error', // Reduce log noise in tests
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/types/**/*',
      ],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
