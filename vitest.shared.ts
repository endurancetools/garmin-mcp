import { defineConfig } from 'vitest/config';

/** Shared vitest setup: resolve workspace packages to their TypeScript sources. */
export function defineProject(root: string) {
  return defineConfig({
    root,
    resolve: { conditions: ['garmin-mcp-source'] },
    ssr: { resolve: { conditions: ['garmin-mcp-source'] } },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'node',
      passWithNoTests: true,
      restoreMocks: true,
    },
  });
}
