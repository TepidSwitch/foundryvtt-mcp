# FoundryVTT MCP Server

[![npm version](https://img.shields.io/npm/v/foundryvtt-mcp)](https://www.npmjs.com/package/foundryvtt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that integrates with FoundryVTT, allowing AI assistants to interact with your tabletop gaming sessions through natural language.

## Features

- **One tool per domain** — `foundry_actors`, `foundry_scenes`, `foundry_journals`, ... each with an `action` field, plus an `_edit` twin for writes
- **Full world editing** — actors, items, effects, scenes, tokens, combat, journals, audio, chat, folders, roll tables, macros, files (needs `FOUNDRY_WRITE_ENABLED=true`)
- **Encounter builder** — proposes monsters for the party by XP budget, then places them as one undo step
- **Safe writes** — audit log, undo (whole batches), dry-run mode
- **Canvas editing** (opt-in) — walls, doors, regions, tiles, drawings
- **Code mode** (opt-in) — sandboxed JavaScript for bulk edits, one undo for the whole run
- **AI map generation** (opt-in) — through your own ComfyUI server
- **Live connection** — Socket.IO loads the complete world state on connect
- **Diagnostics** — server health from the world snapshot and this server's own log

See [docs/guides/fork-setup.md](docs/guides/fork-setup.md) for the full tool table, every setting and Windows notes.

## Quick Start

### Prerequisites

- Node.js 18+ (or [Bun](https://bun.sh/))
- FoundryVTT server running with an active world
- MCP-compatible AI client (Claude Desktop, Claude Code, VS Code, etc.)

### Recommended: Create a Dedicated API User

It is recommended to create a separate FoundryVTT user account for the MCP server rather than using your own GM or player account. This provides better security and auditability.

**In FoundryVTT:**
1. Go to **Configuration** → **User Management**
2. Click **Create User**
3. Set a username (e.g., `mcp-api`) and a strong password
4. Assign the **Assistant GM** role (needed to read world data and roll dice)
5. Use this account's credentials in your MCP configuration

**Benefits:**
- Chat messages and actions from the MCP server are clearly attributed to a separate user
- You can revoke access by disabling the API user without affecting your own account
- Limits blast radius if credentials are ever exposed

### Installation

Run directly without installing — no clone needed:

```bash
bunx foundryvtt-mcp
```

Or with npx:

```bash
npx -y foundryvtt-mcp
```

### Client Configuration

#### Claude Desktop / Claude Code

Add to your MCP configuration (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "bunx",
      "args": ["foundryvtt-mcp"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "your_username",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

#### VS Code

Add to your VS Code MCP settings:

```json
{
  "servers": {
    "foundryvtt": {
      "command": "bunx",
      "args": ["foundryvtt-mcp"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "your_username",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

### Development Setup

For local development or contributing:

```bash
git clone https://github.com/laurigates/foundryvtt-mcp.git
cd foundryvtt-mcp
bun install
bun run setup-wizard
```

The setup wizard will detect your FoundryVTT server, test connectivity, and generate your `.env` configuration.

To configure manually, see the [Configuration Guide](docs/guides/configuration.md).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FOUNDRY_URL` | Yes | FoundryVTT server URL (e.g., `http://localhost:30000`) |
| `FOUNDRY_USERNAME` | Yes | FoundryVTT user account |
| `FOUNDRY_PASSWORD` | Yes | FoundryVTT user password |
| `FOUNDRY_USER_ID` | No | Bypass username-to-ID resolution |
| `FOUNDRY_WRITE_ENABLED` | No | Enable game-state mutations — `true` required for the write tools (default: `false`) |
| `FOUNDRY_TOOLSETS` | No | Comma-separated toolsets to expose (default: all except `canvas` and `script`) |
| `FOUNDRY_DRY_RUN` | No | `true` logs writes without sending them |
| `COMFYUI_URL` | No | ComfyUI server URL; enables AI map generation |
| `COMFYUI_API_KEY` | No | Key for a hosted or proxied ComfyUI (sent as a Bearer token) |
| `COMFYUI_AUTH_HEADER` | No | Header that carries the ComfyUI key, if not `Authorization` |
| `COMFYUI_SCENE_FOLDER` | No | Scene folder for generated maps (default: `Generated Maps`) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error` (default: `info`) |
| `FOUNDRY_TIMEOUT` | No | Request timeout in ms (default: `10000`) |

## Usage

Ask your AI assistant things like:

- "Roll 1d20+5 for an attack roll"
- "Put a goblin ambush token group on the active scene"
- "Rename every marker token to match its actor"
- "Show me all the NPCs in this scene"
- "What's the current combat initiative order?"
- "Search the world for anything related to dragons"
- "Find a CR 3 undead in the compendium"

## Available Tools

Tools are named `foundry_<domain>` (read) and `foundry_<domain>_edit` (write); pick the operation with `action`. `_edit` tools are hidden unless `FOUNDRY_WRITE_ENABLED=true`.

| Domain | Read | Write |
|--------|------|-------|
| actors | `foundry_actors`: search, get, items, party, find_in_party, compare | `foundry_actors_edit`: update, set_ownership, import, request_rest, heal, damage, set_temp_hp |
| items | `foundry_items`: search | `foundry_items_edit`: create, update, delete, use, add_to_actor, update_on_actor, remove_from_actor |
| effects | | `foundry_effects_edit` |
| scenes, tokens | `foundry_scenes`: search, get, suggest, image | `foundry_scenes_edit` (incl. fit_grid), `foundry_tokens_edit` (incl. place_group, place_encounter) |
| combat | `foundry_combat`: state | `foundry_combat_edit`: start, next_turn, set_initiative, end |
| journals | `foundry_journals`: search, get | `foundry_journals_edit` |
| compendium | `foundry_compendium`: search, get, packs, roll_table | |
| audio | `foundry_audio`: list | `foundry_audio_edit` |
| chat | `foundry_chat`: read, roll | `foundry_chat_edit`: send, request_roll, draw_table |
| world | `foundry_world`: summary, search, browse, users, refresh | `foundry_world_edit`: create_folder, move_to_folder, create_macro, update_macro, delete_macro |
| tables | | `foundry_tables_edit`: create_table, update_table, add_results, remove_results, delete_table, reset_table |
| files | `foundry_files`: browse | `foundry_files_edit`: mkdir, upload |
| generate | `foundry_generate`: npc (compendium NPC finder), loot, encounter, map_status, rule | `foundry_generate_edit`: map, cancel_map (needs `COMFYUI_URL`) |
| history | `foundry_history`: log | `foundry_history_edit`: undo |
| diagnostics | `foundry_diagnostics`: health, system, logs, search_logs, diagnose | |
| canvas (opt-in) | `foundry_canvas`: list | `foundry_canvas_edit`: walls, regions, tiles, drawings |
| script (opt-in) | | `foundry_script`: run |

Action lists for the opt-in and smaller tools are in [docs/guides/fork-setup.md](docs/guides/fork-setup.md#tools).

## Available Resources

- `foundry://actors`, `foundry://items`, `foundry://scenes`, `foundry://scenes/current`, `foundry://journals`, `foundry://users`
- `foundry://combat` — active combat; `combatants` are in initiative order, so `combat.turn` indexes them directly
- `foundry://world/settings` — world and campaign settings
- `foundry://script-api.d.ts` — declarations for the `foundry_script` sandbox API
- `foundry://system/diagnostics` — health computed from the world snapshot and the MCP log

## Troubleshooting

The connectivity and setup helpers ship in the source tree (not the published `bin`), so run them from a dev checkout:

```bash
git clone https://github.com/laurigates/foundryvtt-mcp.git
cd foundryvtt-mcp && bun install
bun run test-connection   # Probe FoundryVTT connectivity
bun run setup-wizard      # Re-run interactive setup
```

Detailed guide: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## Development

```bash
bun run build          # Compile TypeScript and make dist/index.js executable
bun run dev            # Development mode with hot reload
bun test               # Unit tests (Vitest)
bun run test:e2e       # E2E tests (Playwright)
bun run lint           # Lint code (Biome)
bun run smoke          # Startup smoke test against the local build
bun run smoke:pack     # Pack-and-install smoke test (mirrors what npx consumers get)
```

See [Development Guide](docs/guides/development.md) for project structure, adding tools, testing, and building.

## Roadmap

See [Feature Tracker](docs/blueprint/feature-tracker.md) for completed and planned features.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT License — see [LICENSE](LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/laurigates/foundryvtt-mcp/issues)
- **Discord**: [FoundryVTT Discord](https://discord.gg/foundryvtt) #api-development
- **Docs**: [FoundryVTT API](https://foundryvtt.com/api/)

## Acknowledgments

- FoundryVTT team for the excellent VTT platform
- Anthropic for the Model Context Protocol
- The tabletop gaming community for inspiration and feedback
