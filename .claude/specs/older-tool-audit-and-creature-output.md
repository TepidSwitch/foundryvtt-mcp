# Spec: Older-tool audit and creature-search output

Status: DRAFT — awaiting review (Spec → Refine gate). No code written yet.

## Context

Two MCP servers run side by side against one world:

- **Fork** (`foundryvtt-mcp`, this repo): logs in over Socket.IO, no browser tab needed.
  Strong at party, sheets, scenes; owns combat and chat.
- **Bridge** (`adambdooley/foundry-vtt-mcp`, pinned to v0.8.4): runs through a Foundry
  module in the GM's browser. Strong at editing, journals authoring, playlists, ownership.

Decision: keep the fork, but narrow it to what the bridge lacks. Do not rebuild the
bridge's edit/delete tools here. This spec has two workstreams:

- **A. Audit of the fork's older tools** (combat, chat, journals, dice, generators).
- **B. Creature-search output in the bridge** (replaces the "monster finder" idea).

## Findings (from reading the code, 2026-09-24)

Verified by reading; items marked *(verify)* still need a test against real data.

| # | Tool | Finding |
|---|------|---------|
| A1 | `get_combat_state` | Reads `system.attributes.hp` / `ac.value` straight from raw actor data. Derived values (max HP, AC) are not stored by dnd5e, so the numbers can be missing or wrong. Ignores temp HP, conditions and concentration. The party overview already computes these correctly. *(verify with a live combat)* |
| A2 | `get_journal` | Truncates every page to 500 chars and offers no way to read the rest. Long journals are unreadable in full. |
| A2b | `search_journals` | Matches on page text but prints only names, so a hit gives no hint why it matched. |
| A3 | `get_chat_messages` | Reads `worldData.messages` from the startup snapshot. Whether new messages ever reach that cache is unconfirmed. *(verify)* Strips HTML tags naively and cuts to 200 chars, so dnd5e roll cards lose their totals. Does not mark whispers/blind rolls. |
| A4 | `roll_dice` | Without a REST key (our config) it rolls locally and never posts to Foundry chat, but the output looks like a Foundry roll. |
| A5 | `generate_npc` | Creates nothing in Foundry. Prints random name/race/class with `Math.random` stats and HP that are not valid 5e stat blocks. Superseded by the bridge's `dnd5e-create-npc`. |
| A5b | `generate_loot`, `lookup_rule` | Local, in-process tables; no Foundry data. Quality unreviewed. |
| B1 | bridge `list-creatures-by-criteria` | Filtering works, but rows omit CR, type and HP, and every row says `undead:false` even for undead. Cause: the index entries store flat `challengeRating` / `creatureType` / `hitPoints`, but `formatCreatureListItem` (`packages/mcp-server/src/tools/compendium.ts`) reads only nested `system.*` paths, finds nothing, and drops the fields. The `flags.*` values are derived from the dropped type. |
| B2 | bridge same tool | The module sorts all matches by CR ascending, then name, and slices at `limit` without saying so, so a truncated result looks complete and the *highest*-CR matches are the ones lost. **Correction:** an earlier draft said lower-priority packs were cut off; that is wrong for the enhanced index (pack order plays no part). The response text claiming "packs searched in priority order" was also wrong. |
| B1b | bridge same tool | The module already sends CR, type, size, HP, AC and `hasSpells` / `hasLegendaryActions` per row; the formatter drops all of them (size falls back to a hard-coded `medium`, so every creature looked medium). |

| B3 | bridge module (index build) | Found on the live test: the module sets `hasSpells` from `system.spells` and `hasLegendaryActions` from `system.resources.legact`, which exist on every dnd5e actor, so both are true for all 3,699 indexed creatures and the `hasSpells` / `hasLegendaryActions` filters match everything or nothing. Fixing it needs a module change (rebuild and reinstall on the host) plus an index rebuild, so it is out of scope; the server now leaves those two flags off dnd5e index rows and says so in the tool description. |
| B4 | bridge same tool | dnd5e sizes came through as codes (`med`, `lg`); now mapped to words. |
| A3c | `get_chat_messages` | Live test: new messages do reach the fork live (verify item closed). But a message with no speaker alias shows the sender as "Unknown" even for the GM. Suspected cause: Foundry v12+ renamed `ChatMessage.user` to `author` and the fork still reads `user`. *(verify against the message data)* Whispers are not marked; no dates shown. |

## Requirements

### A. Fork

- **A1** Combat state shows current/max/temp HP and AC using the same derivation as
  `get_party_overview`, plus active conditions and concentration. Missing data is stated
  ("HP unknown"), never shown as `?`.
- **A2** `get_journal` can return a whole page, or the whole journal, on request, without
  changing the default short view. `search_journals` shows which page matched.
- **A3** Chat output renders roll cards as speaker, what was rolled, and total; marks
  whispered/blind messages; and reports whether the data is a live view or a snapshot.
- **A4** `roll_dice` output states the roll was made locally and not posted to Foundry.
- **A5** `generate_npc` is removed from the tool list (or clearly labelled as a
  random-name toy). Decision needed: see Open questions.

### B. Bridge

- **B1** Each creature row includes `challengeRating`, `creatureType` and `hitPoints`
  (when the index has them), and `flags.undead/dragon/fiend` match the type.
- **B2** The result says whether it was truncated, and the note describing result
  order is accurate. (A true total needs a module change, so it is out of scope: the
  server asks for `limit + 1` rows to detect truncation instead.)
- Change lives in `packages/mcp-server` only, so the module already installed in Foundry
  does not need to be replaced.

## Interface contracts

- `get_journal` gains optional `page` (name or id) and `full` (boolean). Defaults keep
  today's behaviour.
- `get_chat_messages` gains optional `type` filter (`roll`, `chat`, `whisper`).
- Bridge tool schema is unchanged; only response fields are added.

## Behavioral scenarios

**A1** *Given* an active combat with a player character who has temp HP and a condition,
*when* `get_combat_state` runs, *then* that combatant shows `HP 11/79 (+10 temp)`, AC,
and the condition, matching the party overview.

**A1b** *Given* a combatant whose actor is missing from the cache, *when* the state is
read, *then* the row says the actor is unknown rather than showing `?`.

**A2** *Given* a journal page longer than 500 characters, *when* `get_journal` is called
with `full: true`, *then* the whole page text is returned.

**A3** *Given* a dnd5e attack-roll chat card, *when* chat is read, *then* the line reads
like "Speaker rolled Attack: 17", not an empty string.

**A3b** *Given* a whispered message, *when* chat is read, *then* it is marked as a whisper.

**B1** *Given* a search for CR 5–7 undead, *when* results return, *then* every row shows a
CR in 5–7, type `undead`, an HP figure, and `flags.undead: true`.

**B2** *Given* more matches exist than `limit`, *when* results return, *then* the response
says how many matched in total and that it was cut off.

## Implementation plan

1. **B first** (small, quick win): branch `stas/creature-output` off the v0.8.4 tag in
   the bridge clone. Prefer flat index fields in `formatCreatureListItem`; add a unit test
   with a flat index entry; read the search loop for B2.
2. **A1** reuse the derived HP/AC helper from the party handler; unit tests with fixtures;
   one read-only live check when a combat exists.
3. **A3**, then **A2**, then **A4/A5** — each its own atomic commit.
4. Keep the existing 608 tests green; add tests alongside each change.

## Out of scope

- Rebuilding bridge tools (token edit/delete, effects, ownership, playlists) in the fork.
- A dedicated encounter-difficulty calculator (revisit after B lands).
- The ComfyUI map generator.
- Any write to the live world during testing.

## Decisions (review gate, 2026-09-24)

1. **Bridge delivery:** local branch only (`stas/creature-output`, off v0.8.4). No upstream PR.
2. **`generate_npc`:** remove it. `generate_loot` / `lookup_rule` still to be reviewed.
3. **Order:** B first, then A.
4. **A3 verify step:** approved. The GM types a whisper to themself in Foundry chat and
   the fork's `get_chat_messages` is read before and after.

## Progress

- B1, B1b, B2: committed on `stas/creature-output` (`477e5c0`), live-tested against the
  real world after a backend restart: CR/type/size/HP/AC present, `truncated` correct.
- B3, B4 and the echoed-limit fix: implemented after the live test, 10 tests, full bridge
  suite green (188). Not yet committed; needs a second backend restart to re-check live.
- Not doing: patching the bridge's ComfyUI reconnect loop (the user will turn off the
  module's auto-start setting instead).
