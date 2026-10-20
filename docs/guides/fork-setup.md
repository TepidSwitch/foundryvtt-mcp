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

## Dedicated MCP Foundry user

The MCP server logs in to Foundry as a real user with `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD`. Give it its own account instead of reusing your GM login. Its actions are then attributed to that account in Foundry, and its password can be rotated without touching yours.

Create the user in Foundry under Setup > Users (as a GM). Pick a role from the table below and set a password that is not used anywhere else.

| Role | What it can do through the MCP | Tradeoff |
|------|--------------------------------|----------|
| Game Master | Everything the write tools do, plus GM-only settings, file upload, macro scripts and user management | Largest blast radius: a leaked password controls the whole world |
| Assistant GM | Write tools for documents (actors, items, tokens, scenes, journals, chat) and file browsing. Settings outside a fixed list need the SETTINGS_MODIFY permission. Cannot create GM users or users with special permissions. File upload and macro scripts depend on the world's permission config | Smaller blast radius for everyday GM-assist work. Use this unless you need the GM-only operations |
| Player or Trusted Player | Read-only use. Write tools are rejected | `foundry_diagnostics health` warns when `FOUNDRY_WRITE_ENABLED=true` with this role |

Store the credentials for this account in the MCP config file, not in the Claude config:
- Linux/macOS: `~/.config/foundryvtt-mcp/.env`
- Windows: `%APPDATA%\foundryvtt-mcp\.env`

Set `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` to the dedicated account, and set `FOUNDRY_WRITE_ENABLED=true` only when you want the write tools active.

To confirm the login role, run `foundry_diagnostics` with action `health`. The "Login Role" section shows the role and any warning or note for it.

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
| `FOUNDRY_TOOLSETS` | all but `canvas` and `script` (so `tables` is on) | Comma-separated toolsets to expose: `actors`, `items`, `effects`, `scenes`, `tokens`, `combat`, `journals`, `compendium`, `audio`, `chat`, `world`, `tables`, `files`, `generate`, `history`, `diagnostics`, `canvas`, `script`. Setting it replaces the default list, so name every toolset you want. Unknown names are ignored with a warning |
| `COMFYUI_URL` | unset | Base URL of a ComfyUI server, e.g. `http://192.168.1.50:8188`. Turns on AI map generation (`foundry_generate_edit`); see [AI map generation](#ai-map-generation-optional) |
| `COMFYUI_CHECKPOINT` | `dDBattlemapsSDXL10_upscaleV10.safetensors` | SDXL checkpoint file name, as ComfyUI lists it |
| `COMFYUI_VAE` | `sdxl_vae.safetensors` | VAE file name, as ComfyUI lists it |
| `COMFYUI_API_KEY` | unset | Key for a hosted or proxied ComfyUI. Sent as `Authorization: Bearer <key>`. The key is never logged |
| `COMFYUI_AUTH_HEADER` | `Authorization` | Header that carries `COMFYUI_API_KEY`. Any header other than `Authorization` gets the raw key, with no `Bearer` prefix |
| `COMFYUI_SCENE_FOLDER` | `Generated Maps` | Scene folder for generated maps, created when missing. The map `folder` argument overrides it |
| `FOUNDRY_AUDIT_FILE` | state dir | JSONL write log path, or `off` for memory only. Default: `~/.local/state/foundryvtt-mcp/writes.jsonl` / `%APPDATA%\foundryvtt-mcp\writes.jsonl` |

## Tools

Each domain is one tool with an `action` field, split into a read tool and an
`_edit` write tool so the MCP annotations stay accurate (`readOnlyHint` on
reads; `destructiveHint` only on tools that update or delete). `_edit` tools are
hidden, and refused if called, unless `FOUNDRY_WRITE_ENABLED=true`.

| Toolset | Read tool (actions) | Write tool (actions) |
| --- | --- | --- |
| actors | `foundry_actors`: search, get, items, party, find_in_party, compare | `foundry_actors_edit`: update, set_ownership, import, request_rest, heal, damage, set_temp_hp |
| items | `foundry_items`: search | `foundry_items_edit`: create, update, delete (world items); use (post an item card); add_to_actor, update_on_actor, remove_from_actor |
| effects | | `foundry_effects_edit`: list, create, update, delete (actors and items); apply_status, remove_status |
| scenes | `foundry_scenes`: search, get, suggest, image | `foundry_scenes_edit`: activate, update, fit_grid, add_note, remove_note, add_light, remove_light |
| tokens | | `foundry_tokens_edit`: place, place_group, place_encounter, update, delete, move |
| combat | `foundry_combat`: state | `foundry_combat_edit`: start, next_turn, set_initiative, end |
| journals | `foundry_journals`: search, get | `foundry_journals_edit`: create, add_page, append, replace_page, rename, delete, write_session_notes |
| compendium | `foundry_compendium`: search, get, packs, roll_table | |
| audio | `foundry_audio`: list | `foundry_audio_edit`: play, stop, create_playlist, add_sound, update, delete, set_scene_music |
| chat | `foundry_chat`: read, roll | `foundry_chat_edit`: send, request_roll, draw_table |
| world | `foundry_world`: summary, search, browse, users, refresh | `foundry_world_edit`: create_folder, move_to_folder, create_macro, update_macro, delete_macro |
| tables | | `foundry_tables_edit`: create_table, update_table, add_results, remove_results, delete_table, reset_table |
| canvas (off by default) | `foundry_canvas`: list | `foundry_canvas_edit`: add_walls, add_room, set_door, remove_walls, add_region, update_region, remove_region, add_tile, update_tile, remove_tile, add_drawing, update_drawing, remove_drawing |
| script (off by default) | none | `foundry_script`: run |
| files | `foundry_files`: browse | `foundry_files_edit`: mkdir, upload |
| generate | `foundry_generate`: npc, loot, encounter, map_status, rule | `foundry_generate_edit`: map, cancel_map (needs `COMFYUI_URL`) |
| history | `foundry_history`: log | `foundry_history_edit`: undo |
| diagnostics | `foundry_diagnostics`: health, system, search_logs, logs, diagnose | |

That is 13 tools read-only and 26 with writes enabled (27 with `COMFYUI_URL` set, which adds `foundry_generate_edit`). The off-by-default toolsets add `foundry_canvas` (read) and `foundry_canvas_edit` (write) for `canvas`, and `foundry_script` (write only) for `script`. Counts are from the registry with the default toolsets.

List actions for canvas, world browse, journal search, actor search, audio list and files browse take an `offset` argument. When more results remain, the footer says `next offset=<n>`; pass that number to get the next page.

Roll tables: `foundry_tables_edit` changes the tables and their rows. `foundry_chat_edit draw_table` draws from them and honours `replacement: false`; `reset_table` makes drawn rows drawable again. Macros are managed with `foundry_world_edit` (`create_macro`, `update_macro`, `delete_macro`). The server never runs a macro. A script macro needs the MACRO_SCRIPT permission.

Encounters: `foundry_generate encounter` proposes a set of monsters for the party by CR and XP budget. It creates nothing. `foundry_tokens_edit place_encounter` turns that output into imported actors, tokens and optionally combat, as one undo step.

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

- Writes are off unless `FOUNDRY_WRITE_ENABLED=true`; `FOUNDRY_DRY_RUN=true` logs them without sending.
- `foundry_history log` lists recent writes made through this server (survives restarts).
- `foundry_history_edit undo` reverses the newest one (or a `write_id`): creates are
  deleted, updates restore the fields they touched, deletes are re-created with
  their original id. A batch (a script run, or a multi-document write such as `add_room`)
  is undone as a whole. Best effort: later edits to the same document are not
  detected, and a field an update newly added is not removed.
- `foundry_journals_edit write_session_notes` turns a markdown recap into a new GM-only
  journal entry with `@UUID` links for known actor/scene/journal names.

## Script toolset (code mode)

Name `script` in `FOUNDRY_TOOLSETS` (and set `FOUNDRY_WRITE_ENABLED=true`) to add
`foundry_script`. The agent sends JavaScript that runs in a QuickJS (WASM) sandbox with no
network, files, `process` or `require`; its only way out is the `foundry` object
(`list`, `get`, `create`, `update`, `delete`, `chat`). The full declarations are the MCP
resource `foundry://script-api.d.ts`.

- Limits per run: 150 API calls, 30 deleted documents, 60 seconds, 64 MB, 20,000
  characters of output.
- Every write in a run shares one batch id, so one `foundry_history_edit undo` reverts the
  whole script.
- The first run of any script (by hash, per server process) is a dry run: writes are
  logged but not sent, and created documents get placeholder ids, so a script that reads
  back what it just created sees nothing. Repeat the same code with `dry_run: false` to
  apply it. `FOUNDRY_DRY_RUN=true` makes every run dry.
- `foundry.list` and `foundry.get` read the cached world (actors, items, scenes,
  journals, macros, playlists, tables, cards, folders, combats), not compendiums or files.
- Scripts cannot write `User` or `Setting` documents.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `No session cookie returned from /join` | World stopped or host restarting; launch the world and retry (it retries by itself) |
| `JOIN.ErrorUserDoesNotExist` | Wrong `FOUNDRY_USERNAME` (display name, case-sensitive) or the v14 `userId` patch missing |
| Generic HTTP 400 on `/join` | Missing `Origin` header (v14 CSRF check); the branch sends it |
| Desktop shows the server disconnected | Read `mcp-server-foundryvtt-mcp.log` in Desktop's log folder; fully quit and relaunch |
