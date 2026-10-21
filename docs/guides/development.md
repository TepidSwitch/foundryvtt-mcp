# Development Guide

## Project Structure

```
src/
├── config/              # Zod-validated configuration
├── foundry/
│   ├── auth.ts          # Socket.IO 4-step authentication
│   ├── client.ts        # FoundryVTT client with worldData cache
│   └── types.ts         # TypeScript interfaces + WorldData
├── tools/
│   ├── base.ts          # Shared tool types, toolset names
│   ├── domain.ts        # DomainTool and action() declarations
│   ├── registry.ts      # Filters tools by toolset and write mode
│   ├── resources.ts     # MCP resource definitions
│   ├── domains/         # One file per domain tool (schemas and actions)
│   └── handlers/        # Per-action handler implementations
├── diagnostics/         # Optional REST API diagnostics
├── utils/               # Logger, cache utilities
└── index.ts             # MCP server entry point
```

## Adding New Tools

Tools are domains: one read tool (`foundry_<domain>`) or write tool (`foundry_<domain>_edit`), each with an `action` field. To add an action:

1. Declare it with `action({ description, schema, run })` in `src/tools/domains/<domain>.ts`. See `src/tools/domain.ts`. `schema` is a Zod object for the arguments.
2. Implement it in `src/tools/handlers/<file>.ts`, wrapped in `withToolError` (`src/tools/handlers/utils.ts`).
3. Write through the client's `createDocuments`, `updateDocuments` or `deleteDocuments`. Those calls feed the audit log, undo and dry-run. A write that goes around them is not audited or undoable.
4. If the action touches a new document type, add it to `TOP_LEVEL_COLLECTIONS` or `EMBEDDED_COLLECTIONS` in `src/foundry/world-cache.ts`, so the cache follows it.
5. Add the action name to `ACTIONS` in `src/tools/__tests__/registry.test.ts`. For a new tool, also add it to `EXPECTED_SURFACE` there and to `ALL_DOMAIN_TOOLS` in `src/tools/domains/index.ts`.
6. Add unit tests next to the handler, in `src/tools/handlers/__tests__/`.
7. Test with your AI assistant

## Testing

Unit tests are Vitest. Code that talks to Foundry is tested against a fake socket
that asserts the resulting world state (see `.claude/rules/testing.md`). Nothing
here needs a running Foundry except the live smoke suite and Playwright E2E.

```bash
just qa              # lint + type check + unit tests (the pre-commit gate)
just test            # unit tests (npm test)
just test-coverage   # v8 coverage report (informational, no thresholds)
just smoke-live --yes  # scripted check against the REAL world (see below)
npm run test:e2e     # Playwright smoke specs (requires running FoundryVTT)
```

CI for this fork (`.github/workflows/fork-ci.yml`) runs on `stas/**` and `feat/**`
pushes: `bun install --frozen-lockfile`, lint, `tsc --noEmit`, build, unit tests,
and the three smoke tests below. The old Docker-based integration tier was
removed; `just smoke-live` against a real world replaces it.

### Live smoke suite

`just smoke-live --yes` runs a scripted end-to-end check against the REAL Foundry world
through the built server (the same path Claude Desktop uses). It reads the server env from
the Claude Desktop config and refuses to run unless `FOUNDRY_WRITE_ENABLED=true` there and
`--yes` is passed. It prints what it will do first.

It writes to the live world, but only documents named exactly `MCP TEST — delete me`
(plus the actors and folder `place_encounter` imports, which the undo removes). Steps:
create a test actor and scene (`foundry_script`), `place_group`, `fit_grid`, damage /
temp HP / heal on an unlinked token and a read-back from a fresh server process,
`request_rest`, a no-replacement roll table with `draw_table` and `reset_table`,
`create_macro`, an audio playlist (volume-0 sounds, play/stop by name, nothing left playing),
a journal with a replaced page, an active effect (create / disable / enable / delete),
an actor item (`add_to_actor` / `update_on_actor` / `remove_from_actor`), canvas walls and a
region with `offset` paging, `foundry_combat_edit` start / `next_turn` / `end` (the previously
active combat must be active again), `foundry_generate encounter`, and `place_encounter` with
`start_combat`. `undo_hp` checks both a token with an hp override (restored) and a fresh token
without one (the override is removed, base actor unchanged). Scene activate/update and item
`use` are deliberately skipped because they disturb connected players.
It aborts if any `MCP TEST` document already exists. Cleanup always runs (also on failure
or Ctrl-C): every write made during the run is undone newest first with
`foundry_history_edit undo`, then it checks the world search, document ids and the active
combat match the state before the run. Anything it cannot undo is printed with type, id
and name for manual deletion. `--only create_actor,place_group` runs a subset (with the
steps they need). Not part of CI or `npm test`.

### Smoke tests

Smoke tests verify the server boots end-to-end without a live FoundryVTT.
They run in Fork CI and catch failure modes that the mocked Vitest
suite cannot:

```bash
npm run smoke        # Spawn dist/index.js, verify the startup banner on stderr
npm run smoke:dotenv # Verify the secrets-file load order
npm run smoke:pack   # npm pack -> install into a fresh consumer -> verify banner
```

`smoke` covers construction-time and import-time regressions (SDK shape
changes, ESM resolution). `smoke:pack` additionally validates that the
`package.json` `files` glob ships every runtime path the entrypoint needs —
the kind of regression that only surfaces for users running `npx foundryvtt-mcp`
or `bunx foundryvtt-mcp`, not for anyone running the source tree.

## Building

```bash
# Development build
npm run build

# Clean build
npm run clean && npm run build

# Development mode with hot reload
npm run dev
```

## API Documentation (TypeDoc)

Complete API documentation is auto-generated from TypeScript source code and JSDoc comments.

```bash
npm run docs        # Generate documentation
npm run docs:serve  # Generate and serve locally
```

### What's Documented

- **FoundryClient API** — complete client documentation with examples
- **TypeScript Interfaces** — all data structures and type definitions
- **Configuration** — environment variables and setup options
- **Utilities** — helper functions and logging
- **Usage Examples** — code samples for common operations

The documentation is automatically updated via GitHub Actions when source code changes.
