import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    coverage: { include: ['src/**'], exclude: ['src/server.ts', 'src/seed-cli.ts'] },
  },
})
