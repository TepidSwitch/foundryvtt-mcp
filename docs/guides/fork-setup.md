# Fork setup (Linux and Windows)

Notes for running the `stas/local-enhancements` branch with Claude Desktop.
Foundry v14 / dnd5e, Socket.IO login (no Foundry module needed).

## Install

```bash
git clone https://github.com/TepidSwitch/foundryvtt-mcp
cd foundryvtt-mcp
git switch stas/local-enhancements
npm install
npm run build
```

Needs Node 18+. `npm install` runs husky's `prepare` hook; that is harmless for
a consumer checkout. The build is cross-platform (no `chmod`).

## Credentials: use a secrets file

Keep the password out of the Claude Desktop config. Create a file with:

```
FOUNDRY_USERNAME=YourGmUserName
FOUNDRY_PASSWORD=your-foundry-password
```

| OS | Default location (auto-loaded if present) |
| --- | --- |
| Linux/macOS | `~/.config/foundryvtt-mcp/.env` (or `$XDG_CONFIG_HOME/foundryvtt-mcp/.env`) — `chmod 600` it |
| Windows | `%APPDATA%\foundryvtt-mcp\.env` |

Or point anywhere with `FOUNDRY_ENV_FILE`. Variables already set in the Desktop
config win over the file. On Linux the server warns on stderr if the file is
readable by other users.

## Claude Desktop config

| OS | Config file |
| --- | --- |
| Linux | `~/.config/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "foundryvtt-mcp": {
      "command": "node",
      "args": ["C:/Users/you/foundryvtt-mcp/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "https://your-world.example.com",
        "FOUNDRY_WRITE_ENABLED": "true",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Use forward slashes (or doubled backslashes) in Windows paths and the full path
to `node.exe` if Desktop cannot find `node`. Fully quit and relaunch Desktop
after editing; closing the window is not enough.

## Settings added in this branch

| Variable | Default | Effect |
| --- | --- | --- |
| `FOUNDRY_ENV_FILE` | auto | Secrets file path |
| `FOUNDRY_DRY_RUN` | `false` | Log writes but send nothing; tool output carries a DRY RUN banner |
| `FOUNDRY_AUDIT_FILE` | state dir | JSONL write log path, or `off` for memory only. Default: `~/.local/state/foundryvtt-mcp/writes.jsonl` / `%APPDATA%\foundryvtt-mcp\writes.jsonl` |

## Startup behaviour

The server answers Claude's MCP handshake immediately and logs in to Foundry in
the background, retrying with exponential backoff (1s to 30s, with jitter).
Tool calls wait up to 45s for the connection. A rejected password (HTTP 401)
stops retrying and says so. If a reconnect leaves an expired session, the next
call does a full re-login. `get_health_status` shows connecting / connected /
login rejected, the last error with a plain-language hint, and how old the
world data is.

## Write safety

- `get_write_log` lists recent writes made through this server (survives
  restarts).
- `undo_last_write` reverses the newest one (or a `write_id`): creates are
  deleted, updates restore the fields they touched, deletes are re-created with
  their original id. Best effort: later edits to the same document are not
  detected, and a field an update newly added is not removed.
- `write_session_notes` turns a markdown recap into a new GM-only journal entry
  with `@UUID` links for known actor/scene/journal names.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `No session cookie returned from /join` | World stopped or host restarting; launch the world and retry (it retries by itself) |
| `JOIN.ErrorUserDoesNotExist` | Wrong `FOUNDRY_USERNAME` (display name, case-sensitive) or the v14 `userId` patch missing |
| Generic HTTP 400 on `/join` | Missing `Origin` header (v14 CSRF check); the branch sends it |
| Desktop shows the server disconnected | Read `mcp-server-foundryvtt-mcp.log` in Desktop's log folder; fully quit and relaunch |
