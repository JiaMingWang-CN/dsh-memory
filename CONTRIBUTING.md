# Contributing

Thanks for improving dsh-memory.

## Development environment

- Node.js `>=24.9.0`
- pnpm (see `packageManager`-independent setup in README)
- Windows, macOS and Ubuntu are supported by CI.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm format:check
```

## Required checks

Every change must pass lint, typecheck, tests, build and formatting before review. New behavior needs tests; bug fixes need a test that fails without the fix. Do not claim verification that was not run.

## Commit convention

Use Conventional Commits in English:

- `feat(scope): ...`
- `fix(scope): ...`
- `docs: ...`
- `test: ...`
- `chore: ...`

Keep each commit a coherent, reviewable unit. Do not commit `node_modules`, `dist`, coverage, `.codegraph`, `.agents` or secrets.

## Pull requests

- Keep changes focused and explain user-visible behavior changes.
- Update README/CHANGELOG when behavior changes.
- Do not change the public API, license or release channel without maintainer approval.
