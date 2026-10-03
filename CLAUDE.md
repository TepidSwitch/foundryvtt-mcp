# Project: foundryvtt-mcp

Model Context Protocol (MCP) server bridging AI assistants with FoundryVTT tabletop gaming software.

## Tech Stack

- **Language**: TypeScript (ES modules, `.js` imports for MCP SDK compatibility)
- **Runtime**: Node.js (Bun as package manager)
- **Test**: Vitest (unit + integration), Playwright (E2E)
- **Lint/Format**: Biome (linting + formatting)
- **Validation**: Zod schemas

## Essential Commands

```bash
bun run build          # Compile TypeScript
bun run dev            # Development mode with hot reload
bun test               # Unit tests (Vitest)
bun run test:integration # Integration tests (needs :30001 container + .env.integration — prefer `just test-integration-docker`)
bun run test:e2e       # E2E tests (Playwright, headless)
bun run lint           # Lint code (Biome)
bun run lint:fix       # Auto-fix lint issues
bun run format         # Format code (Biome)
bun run test-connection # Test MCP→FoundryVTT connection
```

## Architecture

### Data Flow

1. AI assistant calls MCP tool → `src/tools/router.ts`
2. Router dispatches to handler → `src/tools/handlers/`
3. Handler queries cached worldData → `src/foundry/client.ts`
4. Response returned as MCP result

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Client | `src/foundry/client.ts` | Socket.IO connection, world state cache |
| Auth | `src/foundry/auth.ts` | 4-step Socket.IO authentication |
| Config | `src/config/index.ts` | Zod-validated environment config |
| Tools | `src/tools/definitions.ts` | MCP tool schemas |
| Router | `src/tools/router.ts` | Request→handler dispatch |
| Types | `src/foundry/types.ts` | FoundryVTT entity interfaces |

### Authentication & transport selection

`client.ts` selects transport purely by whether `FOUNDRY_API_KEY` is set:

- **`FOUNDRY_API_KEY` unset → Socket.IO mode** (default): authenticates with
  `FOUNDRY_USERNAME`/`FOUNDRY_PASSWORD` and loads full `worldData`.
- **`FOUNDRY_API_KEY` set → REST API mode**: connects to the REST module's
  `/api/status` instead. This is a transport **switch**, not an additive layer —
  it does not run alongside the Socket.IO `worldData` path.
- `USE_REST_MODULE` (seen in some `.env`/example files and the `test-connection`
  tips) is **not read** by `src/config/index.ts` — it is a no-op. Transport is
  decided solely by `apiKey` presence.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_URL` | Yes | FoundryVTT server URL |
| `FOUNDRY_USERNAME` | Yes | FoundryVTT user |
| `FOUNDRY_PASSWORD` | Yes | FoundryVTT password |
| `FOUNDRY_USER_ID` | No | Bypass username→ID resolution |
| `FOUNDRY_API_KEY` | No | REST API module key (read-only diagnostics path) |
| `FOUNDRY_WRITE_ENABLED` | No | Enable game-state mutations — `true` required for the write tools (default `false`) |
| `LOG_LEVEL` | No | `debug` for verbose output |
| `FOUNDRY_TIMEOUT` | No | Request timeout (ms, default 10000) |

## Live checks

`just live-check --read` (or `npx tsx scripts/live-check.ts ...` if `just` isn't installed) spawns the built `dist/index.js` and talks to the real world like Claude Desktop does. Run `npm run build` first.

- `--read`: users, world summary, health (read-only, safe anytime)
- `--dry-run --call <tool> '<json>'`: sets `FOUNDRY_DRY_RUN=true`, writes are simulated
- `--call <tool> '<json>'`: real call; write checks only on documents named `MCP TEST — delete me`, then `undo_last_write` and search to confirm nothing is left

Foundry and dnd5e client source for checking field names lives outside the repo at `~/foundry-dev/foundry/` (licensed, never commit).

## Critical pitfalls (verified live against Foundry 14.368 / dnd5e 6.0.5)

- **Writes**: every write goes `assertWriteable()` → `emitWithAck()` → `modifyDocument()` in `client.ts`, and is audited (`write-audit.ts`) and dry-run aware. Don't bypass it.
- **Unlinked token actors**: parent UUID is `Scene.<sid>.Token.<tid>.ActorDelta.<tid>`. v14 rejects `...Token.<tid>.Actor.<aid>`. The cache resolves it (`resolveParent` in `world-cache.ts`).
- **Deleting keys**: `{"-=key": null}` is deprecated (removed in v16). Wire form is `{key: {"__$OPERATOR$__": "ForcedDeletion"}}`. `planUndo` still emits the old form until the tool-regroup phase.
- **ActiveEffects**: changes live in `system.changes[]` with a string `type` (`add`, `override`, ...), not `changes[].mode`. MeasuredTemplate is gone; use Regions.
- **Broadcasts skip the sender**: Foundry never echoes a `modifyDocument` back to the client that made it, so `client.ts` applies its own results to the cache.
- **Files**: upload is HTTP `POST /upload` multipart (`source=data`, `target=<dir>`, `upload=<file>`) with the session cookie. Browse/mkdir are the socket event `manageFiles` (`{action:"browseFiles"|"createDirectory", storage:"data", target}`) with an ack.
- **Player rolls without a module**: dnd5e 6 chat enrichers (`[[/check ...]]`, `[[/save ...]]`, `[[/skill ...]]`, `[[/item ...]]`, ...) posted as a normal chat message give players a button. Check option syntax in `enrichString` in `dnd5e.mjs` before use.
- **Molten stops idle servers**: `/join` returns 302 to the lobby with `status=NOT_RUNNING`. `auth.ts` detects it; ask the user to start the server from the Molten dashboard.
- **stdout is the JSON-RPC stream**: log to stderr only (`logger`), never `console.log` in the server.
- **Computed values**: the world snapshot is raw source data. Max HP, AC, proficiency, skill totals and slots must be computed (`dnd5e.ts`); stored `mod`/`prof`/`spelldc` can be stale.
- **Claude Desktop** must be fully quit and relaunched to load a new build.

## Rules

See `.claude/rules/` for detailed guidelines:
- `development.md` — TDD workflow, commit conventions, build commands
- `testing.md` — Test tiers (unit, integration, E2E) and requirements
- `foundry-write-protocol.md` — transport (Socket.IO vs REST) and the `modifyDocument` write protocol
- `document-management.md` — Document detection and organization

## Reference

- [FoundryVTT API](https://foundryvtt.com/api/)
- [Playwright Docs](https://playwright.dev/docs/intro)
- [MCP SDK](https://modelcontextprotocol.io/docs)
