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
| `FOUNDRY_TOOLSETS` | all but `canvas` and `script` | Comma-separated toolsets to expose: `actors`, `items`, `effects`, `scenes`, `tokens`, `combat`, `journals`, `compendium`, `audio`, `chat`, `world`, `files`, `generate`, `history`, `diagnostics`, `script`. Unknown names are ignored with a warning |
| `COMFYUI_URL` | unset | Base URL of a ComfyUI server, e.g. `http://192.168.1.50:8188`. Turns on AI map generation (`foundry_generate_edit`); see [AI map generation](#ai-map-generation-optional) |
| `COMFYUI_CHECKPOINT` | `dDBattlemapsSDXL10_upscaleV10.safetensors` | SDXL checkpoint file name, as ComfyUI lists it |
| `COMFYUI_VAE` | `sdxl_vae.safetensors` | VAE file name, as ComfyUI lists it |
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
| canvas (off by default) | `foundry_canvas`: list | `foundry_canvas_edit`: add_walls, add_room, set_door, remove_walls, add_region, update_region, remove_region, add_tile, update_tile, remove_tile, add_drawing, update_drawing, remove_drawing |
| files | `foundry_files`: browse | `foundry_files_edit`: mkdir, upload |
| generate | `foundry_generate`: npc, loot, map_status, rule | `foundry_generate_edit`: map, cancel_map (needs `COMFYUI_URL`) |
| history | `foundry_history`: log | `foundry_history_edit`: undo |
| diagnostics | `foundry_diagnostics`: health, system, search_logs, logs, diagnose | |

That is 13 tools read-only and 24 with writes enabled (25 with `COMFYUI_URL` set, which adds `foundry_generate_edit`).

Positions for notes, lights and tokens are grid squares from the top-left of the map image. Roll requests and item cards post dnd5e inline enrichers (`[[/check ...]]`, `[[/save ...]]`, `[[/item ...]]`) that players click in chat; no Foundry module is needed.

## Canvas editing (off by default)

Walls, doors, regions, tiles and drawings are low-level scene edits, so they sit in the
`canvas` toolset, which is off unless you name it, for example
`FOUNDRY_TOOLSETS=actors,items,scenes,combat,journals,chat,world,history,diagnostics,canvas`
(or just `canvas` next to your usual list). Naming it adds `foundry_canvas` (read) and
`foundry_canvas_edit` (write, only with `FOUNDRY_WRITE_ENABLED=true`).

- Positions are grid squares from the top-left of the map image; `(0,0)` is that corner.
  Wall ends sit on grid lines. The scene's padding and shift are handled for you.
- `foundry_canvas list` shows ids and positions. A scene can have hundreds of walls, so
  filter by category (`doors`, `terrain`, ...) or give an area (`x`, `y`, `width`, `height`).
- `add_walls` and `add_room` are a single write, so one `foundry_history_edit undo` removes
  every wall they added. `add_room` can leave a door in one side.
- Wall kinds: `wall`, `door`, `secret_door`, `window` (movement blocked, sight passes),
  `invisible` (movement only), `terrain` (limits sight), `ethereal` (sight only).
- Regions are the v14 replacement for measured templates. Shapes: rectangle, circle,
  ellipse, cone, ring, polygon. They are created without behaviors; add teleports and
  triggers in Foundry.
- Tiles take an image path from the data folder (upload one with `foundry_files_edit`).

## Files

`foundry_files browse` lists Foundry's data folder. `foundry_files_edit upload` sends a
file from the machine running this server (image, audio, video or PDF, up to 25 MB) to
`worlds/<world>/mcp-uploads/` unless you give a folder, and returns the path to use for
a scene background or token. Folders under `modules/` and `systems/` are refused.
Uploads cannot be undone from here; remove a file with the webdav tools. Their root is
Foundry's user folder, so the data folder is `/Data/...`: delete the file path first
(`/Data/worlds/<world>/mcp-uploads/<file>`), then the folder with a trailing slash. The
tool says "Path does not exist" for a bare folder path.

## AI map generation (optional)

Nothing here is required. Without `COMFYUI_URL` the map tool is not offered.

ComfyUI is free, open-source software you run yourself; the D&D battlemap SDXL model is a
free download. The only cost is a machine with a GPU (an SDXL render needs roughly 8 GB of
VRAM; a 4 GB laptop GPU is too small). No hosted service or account is involved.

On the GPU machine (Windows example):

1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and the SDXL battlemap
   checkpoint plus `sdxl_vae.safetensors`. Put them in `models/checkpoints` and `models/vae`.
2. Start it listening on the network: `python main.py --listen 0.0.0.0` (port 8188).
3. Allow TCP 8188 in Windows Firewall for the **private** network only.
4. Set `COMFYUI_URL=http://<that machine's LAN address>:8188` for this server. If your
   checkpoint file has a different name, set `COMFYUI_CHECKPOINT` (and `COMFYUI_VAE`).

`foundry_diagnostics` action `health` then reports whether ComfyUI is reachable. A map
request returns a job id immediately; the render runs in the background, and when it
finishes the image is uploaded and an inactive scene is created. Jobs are kept in memory,
so a server restart forgets them (the render itself continues in ComfyUI). The workflow
and prompt wording come from the foundry-vtt-mcp bridge by adambdooley (MIT).

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
