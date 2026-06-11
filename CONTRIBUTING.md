# Contributing to Anchor

Thanks for your interest in improving Anchor! This is an early-stage project and
contributions are welcome.

## Development setup

Requires [Node 20+](https://nodejs.org).

```bash
git clone https://github.com/Perfectio/obsidian-anchor
cd obsidian-anchor
npm install
npm run build
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm test` | Run the fast, hermetic unit + integration tests (no model downloads). |
| `ANCHOR_E2E=1 npx vitest run test/e2e.demo.test.ts` | Run the full demo with real models. |
| `npm run eval` | Run the grounding eval and print refusal precision (downloads the NLI model once). |
| `npm run lint` | ESLint. |
| `npm run typecheck` | `tsc --noEmit`. |

## Ground rules

- **stdout is the MCP transport.** Never write to stdout from `src/` — all logging
  goes through `src/util/logger.ts` (stderr only). `console.*` is lint-banned in `src/`.
- **The eval is the product.** Changes to the grounding pipeline must keep
  `npm run eval` passing (refusal precision must not regress).
- Keep the hermetic test suite fast and offline — gate anything that needs real
  models behind `ANCHOR_E2E=1` (see `test/e2e.demo.test.ts`).
- All code, comments, and docs are in English.

## Pull requests

1. Fork and branch from `main`.
2. Make your change with tests.
3. Ensure `npm run lint`, `npm run typecheck`, and `npm test` all pass.
4. Open a PR describing the change and why. CI must be green to merge.

For security issues, see [SECURITY.md](./SECURITY.md) — please do not open a public issue.
