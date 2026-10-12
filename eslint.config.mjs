// ESLint runs only the Nx module-boundary rule. Everything else is oxlint.
import nx from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const libs = ['config', 'auth', 'client', 'store', 'domain'];
const below = (scope) => libs.slice(0, libs.indexOf(scope)).map((s) => `scope:${s}`);

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          // `garmin serve` (apps/cli) starts the MCP server in-process.
          allow: ['garmin-mcp-server'],
          depConstraints: [
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            ...libs.map((s) => ({ sourceTag: `scope:${s}`, onlyDependOnLibsWithTags: below(s) })),
            { sourceTag: 'scope:mcp-server', onlyDependOnLibsWithTags: libs.map((s) => `scope:${s}`) },
            {
              sourceTag: 'scope:cli',
              onlyDependOnLibsWithTags: [...libs.map((s) => `scope:${s}`), 'scope:mcp-server'],
            },
          ],
        },
      ],
    },
  },
];
