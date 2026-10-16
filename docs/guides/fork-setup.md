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
| `FOUNDRY_TOOLSETS` | all but `script` | Comma-separated toolsets to expose: `actors`, `items`, `effects`, `scenes`, `tokens`, `combat`, `journals`, `compendium`, `audio`, `chat`, `world`, `files`, `generate`, `history`, `diagnostics`, `script`. Unknown names are ignored with a warning |
| `FOUNDRY_AUDIT_FILE` | state dir | JSONL write log path, or `off` for memory only. Default: `~/.local/state/foundryvtt-mcp/writes.jsonl` / `%APPDATA%\foundryvtt-mcp\writes.jsonl` |

## Tools

Each domain is one tool with an `action` field, split into a read tool and an
`_edit` write tool so the MCP annotations stay accurate (`readOnlyHint` on
reads; `destructiveHint` only on tools that update or delete). `_edit` tools are
hidden, and refused if called, unless `FOUNDRY_WRITE_ENABLED=true`.

| Toolset | Read tool (actions) | Write tool (actions) |
| --- | --- | --- |
| actors | `foundry_actors`: search, get, items, party, find_in_party, compare | `foundry_actors_edit`: update, set_ownership, import |
| items | `foundry_items`: search | `foundry_items_edit`: create, update, delete (world items); use (post an item card); add_to_actor, update_on_actor, remove_from_actor |
| effects | | `foundry_effects_edit`: list, create, update, delete (actors and items); apply_status, remove_status |
| scenes | `foundry_scenes`: search, get, suggest, image | `foundry_scenes_edit`: activate, update, add_note, remove_note, add_light, remove_light |
| tokens | | `foundry_tokens_edit`: place, update, delete, move |
| combat | `foundry_combat`: state | `foundry_combat_edit`: start, next_turn, set_initiative, end |
| journals | `foundry_journals`: search, get | `foundry_journals_edit`: create, add_page, append, replace_page, rename, delete, write_session_notes |
| compendium | `foundry_compendium`: search, get, packs, roll_table | |
| audio | `foundry_audio`: list | `foundry_audio_edit`: play, stop, create_playlist, add_sound, update, delete, set_scene_music |
| chat | `foundry_chat`: read, roll | `foundry_chat_edit`: send, request_roll, draw_table |
| world | `foundry_world`: summary, search, browse, users, refresh | `foundry_world_edit`: create_folder, move_to_folder |
| generate | `foundry_generate`: npc, loot, rule | |
| history | `foundry_history`: log | `foundry_history_edit`: undo |
| diagnostics | `foundry_diagnostics`: health, system, search_logs, logs, diagnose | |

That is 12 tools read-only and 23 with writes enabled.

Positions for notes, lights and tokens are grid squares from the top-left of the map image. Roll requests and item cards post dnd5e inline enrichers (`[[/check ...]]`, `[[/save ...]]`, `[[/item ...]]`) that players click in chat; no Foundry module is needed.

## Startup behaviour

The server answers Claude's MCP handshake immediately and logs in to Foundry in
the background, retrying with exponential backoff (1s to 30s, with jitter).
Tool calls wait up to 45s for the connection. A rejected password (HTTP 401)
stops retrying and says so. If a reconnect leaves an expired session, the next
call does a full re-login. `foundry_diagnostics` (action `health`) shows connecting / connected /
login rejected, the last error with a plain-language hint, and how old the
world data is.

## Diagnostics without a Foundry module

`get_system_health`, `get_recent_logs`, `search_logs`, `diagnose_errors` and the
system section of `get_health_status` work with no REST/diagnostics module
(`FOUNDRY_API_KEY` unset). Health is computed from the world snapshot (version,
system, users online, active modules, connection and staleness); the log tools
read this MCP server's own recent log (logins, tool failures, write errors).
Foundry's own server log, uptime and memory need a server module and are not
available in this mode.

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
