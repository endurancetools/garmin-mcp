# Contributing

Thanks for helping. Bug reports, questions you wish the server could answer, documentation fixes and code are all welcome.

## Before you start

- **Bugs**: [open an issue](https://github.com/endurancetools/garmin-mcp/issues/new/choose) with the output of `garmin doctor`. Never paste tokens, the contents of `tokens.json` or your database.
- **Security problems**: report them privately, see [SECURITY.md](SECURITY.md).
- **Larger changes** (a new tool, a new metric, a new dependency): open an issue first. The server deliberately has a small set of tools designed around questions, not one tool per Garmin endpoint ([why](https://endurancetools.github.io/garmin-mcp/how-it-works/#designed-tools)), so a new tool usually means extending an existing one.

## Making a change

Setup, repository layout, tests, the tool-list budget, evals and the release process are in [DEVELOPMENT.md](DEVELOPMENT.md). In short:

1. Node.js 22+, `corepack enable`, `pnpm install`.
2. Make the change with tests. Tests run offline against anonymized fixtures; nothing in tests or CI may contact Garmin or contain data from a real account.
3. `pnpm check` (lint, typecheck, test, build) must pass.
4. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, ...), with the Nx project as the scope, e.g. `fix(client): ...`.
5. Open a pull request and fill in the template.

User-facing changes also update the documentation in `docs/` (and `README.md` when it describes the same thing). The changelog is written by hand at release time, so you do not need to edit it.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
