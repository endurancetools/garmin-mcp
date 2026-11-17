// ESLint runs only the Nx module-boundary rule. Everything else is oxlint.
import nx from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const libs = ['config', 'auth', 'client', 'store', 'domain', 'analytics'];
// `fit` (the FIT parser) sits beside the chain: it imports no other package, and `domain` and
// everything above may import it (`domain` only through a dynamic import, see packages/domain/src/fit.ts).
const fitFrom = libs.indexOf('domain');
const below = (scope) => [
  ...libs.slice(0, libs.indexOf(scope)).map((s) => `scope:${s}`),
  ...(libs.indexOf(scope) >= fitFrom ? ['scope:fit'] : []),
];
const all = [...libs.map((s) => `scope:${s}`), 'scope:fit'];

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
            { sourceTag: 'scope:fit', onlyDependOnLibsWithTags: ['scope:fit'] },
            { sourceTag: 'scope:mcp-server', onlyDependOnLibsWithTags: all },
            { sourceTag: 'scope:cli', onlyDependOnLibsWithTags: [...all, 'scope:mcp-server'] },
          ],
        },
      ],
    },
  },
];
