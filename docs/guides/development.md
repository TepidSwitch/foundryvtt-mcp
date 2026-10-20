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

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Lint code
npm run lint

# E2E tests (requires running FoundryVTT)
npm run test:e2e
```

### Smoke tests

Two smoke tests verify the server boots end-to-end without a live FoundryVTT.
They run in CI on every PR and catch failure modes that the mocked Vitest
suite cannot:

```bash
npm run smoke        # Spawn dist/index.js, verify the startup banner on stderr
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
