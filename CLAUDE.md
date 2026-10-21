# Project: foundryvtt-mcp

Model Context Protocol (MCP) server bridging AI assistants with FoundryVTT tabletop gaming software.

## Tech Stack

- **Language**: TypeScript (ES modules, `.js` imports for MCP SDK compatibility)
- **Runtime**: Node.js (Bun as package manager)
- **Test**: Vitest (unit, fake-socket), Playwright (E2E)
- **Lint/Format**: Biome (linting + formatting)
- **Validation**: Zod schemas

## Essential Commands

```bash
bun run build          # Compile TypeScript
bun run dev            # Development mode with hot reload
bun test               # Unit tests (Vitest)
bun run test:e2e       # E2E tests (Playwright, headless)
bun run lint           # Lint code (Biome)
bun run lint:fix       # Auto-fix lint issues
bun run format         # Format code (Biome)
bun run test-connection # Test MCP→FoundryVTT connection
```

## Architecture

### Data Flow

1. AI assistant calls MCP tool → `ToolRegistry` (`src/tools/registry.ts`), filtered by `FOUNDRY_TOOLSETS` and `FOUNDRY_WRITE_ENABLED`
2. The domain tool (`src/tools/domains/*.ts`, built on `src/tools/domain.ts`) validates `action` + fields with Zod and calls a handler in `src/tools/handlers/`
3. Handler queries cached worldData → `src/foundry/client.ts`
4. Response returned as MCP result

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Client | `src/foundry/client.ts` | Socket.IO connection, world state cache |
| Auth | `src/foundry/auth.ts` | 4-step Socket.IO authentication |
| Config | `src/config/index.ts` | Zod-validated environment config |
| Domain tools | `src/tools/domains/` | One `DomainTool` per domain (`foundry_<domain>` read, `foundry_<domain>_edit` write); each action = Zod schema + handler |
| Registry | `src/tools/registry.ts` | Single source of listed/callable tools; toolset and write filtering |
| Types | `src/foundry/types.ts` | FoundryVTT entity interfaces |

### Authentication & transport selection

`client.ts` talks to Foundry over Socket.IO only: it authenticates with
`FOUNDRY_USERNAME`/`FOUNDRY_PASSWORD` (or `FOUNDRY_USER_ID`) and loads full
`worldData`. The REST bridge (`FOUNDRY_API_KEY`) was removed; the variable is
ignored with a startup warning. `USE_REST_MODULE` is likewise not read.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_URL` | Yes | FoundryVTT server URL |
| `FOUNDRY_USERNAME` | Yes | FoundryVTT user |
| `FOUNDRY_PASSWORD` | Yes | FoundryVTT password |
| `FOUNDRY_USER_ID` | No | Bypass username→ID resolution |
| `FOUNDRY_WRITE_ENABLED` | No | Enable game-state mutations — `true` required for the write tools (default `false`) |
| `LOG_LEVEL` | No | `debug` for verbose output |
| `FOUNDRY_TIMEOUT` | No | Request timeout (ms, default 10000) |

## Live checks

`just live-check --read` (`just` strips the quotes from the JSON in `--call`, so use `npx tsx scripts/live-check.ts --call ...` for those) spawns the built `dist/index.js` and talks to the real world like Claude Desktop does. Run `npm run build` first.

- `--read`: users, world summary, health (read-only, safe anytime)
- `--dry-run --call <tool> '<json>'`: sets `FOUNDRY_DRY_RUN=true`, writes are simulated
- `--call <tool> '<json>'` (tool names are the `foundry_*` domain tools; the json carries `action`): real call; write checks only on documents named `MCP TEST — delete me`, then `foundry_history_edit` undo and search to confirm nothing is left

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
- `testing.md` — Test tiers (unit, E2E) and requirements
- `foundry-write-protocol.md` — transport and the `modifyDocument` write protocol
- `document-management.md` — Document detection and organization

## Reference

- [FoundryVTT API](https://foundryvtt.com/api/)
- [Playwright Docs](https://playwright.dev/docs/intro)
- [MCP SDK](https://modelcontextprotocol.io/docs)
