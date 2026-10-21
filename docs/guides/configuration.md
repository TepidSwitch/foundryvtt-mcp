# Configuration Guide

All configuration is environment variables, validated in `src/config/index.ts`.
For the fork-specific walkthrough (credentials, Claude Desktop config, dedicated
user, toolset table, ComfyUI setup) see [fork-setup.md](fork-setup.md); this page
is the variable reference.

## Where variables come from

1. The process environment (for Claude Desktop, the `env` block of its config).
2. A secrets file, loaded without overriding anything already set:
   - Linux/macOS: `~/.config/foundryvtt-mcp/.env` (or `$XDG_CONFIG_HOME/foundryvtt-mcp/.env`)
   - Windows: `%APPDATA%\foundryvtt-mcp\.env`
   - or any path via `FOUNDRY_ENV_FILE`.
3. For local development, a project `.env` (`cp .env.example .env`).

## Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDRY_URL` | required | FoundryVTT URL including protocol, e.g. `http://localhost:30000` |
| `FOUNDRY_USERNAME` | unset | Foundry user (display name, case-sensitive) |
| `FOUNDRY_PASSWORD` | unset | Foundry user password |
| `FOUNDRY_USER_ID` | unset | 16-char user `_id`; skips username resolution |
| `FOUNDRY_SOCKET_PATH` | `/socket.io/` | Socket.IO path |
| `FOUNDRY_TIMEOUT` | `10000` | Request timeout in ms |
| `FOUNDRY_RETRY_ATTEMPTS` | `3` | Retry attempts for failed requests |
| `FOUNDRY_RETRY_DELAY` | `1000` | Delay between retries in ms |
| `FOUNDRY_ENV_FILE` | auto | Explicit secrets file path |

## Writes, safety and tools

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDRY_WRITE_ENABLED` | `false` | Expose and allow the `_edit` write tools |
| `FOUNDRY_DRY_RUN` | `false` | Log writes without sending them; output carries a DRY RUN banner |
| `FOUNDRY_AUDIT_FILE` | `~/.local/state/foundryvtt-mcp/writes.jsonl` (`%APPDATA%\foundryvtt-mcp\writes.jsonl` on Windows) | JSONL write log used by `foundry_history`; `off` keeps it in memory only |
| `FOUNDRY_TOOLSETS` | all except `canvas` and `script` | Comma-separated toolsets. Setting it replaces the default list. Valid names are the `TOOLSETS` array in `src/tools/base.ts` (`actors`, `items`, `effects`, `scenes`, `tokens`, `combat`, `journals`, `compendium`, `audio`, `chat`, `world`, `tables`, `files`, `generate`, `history`, `diagnostics`, `canvas`, `script`); unknown names are ignored with a warning |

## ComfyUI (optional map generation)

Unset `COMFYUI_URL` means the map tool is not offered. Setup is in
[fork-setup.md](fork-setup.md#ai-map-generation-optional).

| Variable | Default | Description |
|----------|---------|-------------|
| `COMFYUI_URL` | unset | ComfyUI base URL, e.g. `http://192.168.1.50:8188` |
| `COMFYUI_CHECKPOINT` | `dDBattlemapsSDXL10_upscaleV10.safetensors` | SDXL checkpoint file name |
| `COMFYUI_VAE` | `sdxl_vae.safetensors` | VAE file name |
| `COMFYUI_API_KEY` | unset | Key for a hosted/proxied ComfyUI (`Authorization: Bearer <key>`); never logged |
| `COMFYUI_AUTH_HEADER` | `Authorization` | Header carrying the key; other headers get the raw key |
| `COMFYUI_SCENE_FOLDER` | `Generated Maps` | Scene folder for generated maps |

## Server and cache

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_NAME` | `foundryvtt-mcp` | Server name reported to clients |
| `MCP_SERVER_VERSION` | `0.1.0` | Server version reported to clients |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | `development` | `development`, `production`, `test` |
| `CACHE_ENABLED` | `true` | Enable response caching |
| `CACHE_TTL_SECONDS` | `300` | Cache duration in seconds |
| `CACHE_MAX_SIZE` | `1000` | Maximum cache entries |

## Security

- Give the MCP its own Foundry user with the lowest role that works (see "Dedicated MCP Foundry user" in [fork-setup.md](fork-setup.md))
- Keep the password in the secrets file, not the Claude Desktop config
- Leave `FOUNDRY_WRITE_ENABLED` off unless you want the write tools
- Run the server on an internal network only

## FoundryVTT Authentication

The MCP server connects to FoundryVTT via Socket.IO using a standard user account. No custom modules are required for full game data access.

### Setup

1. Ensure FoundryVTT is running with an active world (not on the setup screen)
2. Create or use an existing FoundryVTT user account with appropriate permissions
3. Add credentials to your `.env` file

### Authentication Flow

The server authenticates via a 4-step Socket.IO flow:

1. Fetches the `/join` page to obtain a session cookie
2. Extracts the session cookie from the response
3. Resolves the username to a user ID (or uses `FOUNDRY_USER_ID` if set)
4. Emits `joinGame` with credentials to receive the complete world state

### Required Permissions

Your FoundryVTT user needs:

- View actors, items, scenes, and journals
- Access compendium data
- Use dice rolling API

### Diagnostics

`foundry_diagnostics` (actions `health`, `system`, `search_logs`, `logs`, `diagnose`) needs no Foundry module: health comes from the world snapshot and the log actions read this server's own log buffer. The `diagnose` action is a fixed stub. The old REST bridge and `FOUNDRY_API_KEY` were removed; a leftover `FOUNDRY_API_KEY` is ignored with a startup warning. See [fork-setup.md](fork-setup.md#diagnostics).
