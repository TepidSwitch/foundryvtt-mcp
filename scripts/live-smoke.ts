#!/usr/bin/env tsx

/**
 * Live smoke suite: drives the built server (`dist/index.js`) against the REAL
 * Foundry world and exercises the write paths that unit tests cannot cover.
 *
 *   just smoke-live --yes [--only step,step]
 *
 * It WRITES to the live world, but only documents named exactly
 * "MCP TEST — delete me" (plus the compendium actors / folder that
 * place_encounter imports, which are undone). Everything it did is undone in a
 * `finally` via foundry_history_edit undo; anything it cannot undo is printed.
 *
 * Needs FOUNDRY_WRITE_ENABLED=true in the server env (Claude Desktop config)
 * and the --yes flag. Not run in CI or vitest.
 */

import { loadServerEnv, McpSession, type ToolResult } from './lib/mcp-session.js';
import {
  ALL_TOOLSETS,
  type DocRef,
  deltaHasHpValue,
  extractBacktickIds,
  extractCreatures,
  extractHp,
  extractLabeledId,
  extractMessageId,
  findLeftovers,
  missingDocs,
  newDocs,
  newUndoable,
  parsePageFooter,
  parseScriptResult,
  parseSmokeArgs,
  parseWriteLog,
  resolveSteps,
  TEST_NAME,
  TEST_PREFIX,
} from './lib/smoke-helpers.js';

const SNAPSHOT_TYPES = ['Actor', 'Scene', 'RollTable', 'Macro', 'Combat', 'Folder'];

interface Snapshot {
  docs: DocRef[];
  activeCombats: string[];
  /** Chat log size (too many messages to list under the 200-row cap). */
  messageCount: number;
}

interface State {
  actorId?: string;
  sceneId?: string;
  tokenId?: string;
  /** Second token (fresh, no hp override) placed by undo_hp. */
  token2Id?: string;
  chatIds: string[];
  unparsedChat: string[];
  /** Ids of documents this run created; updates may only target these. */
  owned: Set<string>;
  creatures?: Array<{ uuid: string; count: number }>;
  encounterPlaced?: boolean;
  playlistId?: string;
}

interface Step {
  name: string;
  desc: string;
  requires?: string[];
  run: (ctx: Ctx) => Promise<string | undefined>;
}

interface Ctx {
  s: McpSession;
  st: State;
  /** Call a tool, throwing on isError. */
  ok: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  script: <T>(code: string) => Promise<T>;
  freshSession: () => Promise<McpSession>;
}

const HELP = `Usage: just smoke-live --yes [--only step,step]

Runs the live smoke suite against the real Foundry world. Writes only documents
named "${TEST_NAME}" and undoes everything afterwards.
Requires FOUNDRY_WRITE_ENABLED=true in the server env and --yes.

Steps: create_actor, create_scene, place_group, fit_grid, token_hp, hp_persisted,
undo_hp, request_rest, tables, macro, audio, journal, effects, items, canvas,
combat_edit, encounter, place_encounter.
Deliberately not covered (they disturb connected players): scene activate/update
and item use.`;

const say = (s = '') => console.log(s);
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// One script per type: a whole-world snapshot in one result overflows the
// script output cap (20k chars), and foundry.list returns at most 200 rows.
const LIST_CAP = 200;
const snapshotCode = (type: string) => `const list = await foundry.list(${JSON.stringify(type)}, { limit: ${LIST_CAP} });
if (!Array.isArray(list)) throw new Error('list did not return an array');
if (list.length >= ${LIST_CAP}) throw new Error('more than ${LIST_CAP - 1} ${type} documents; snapshot would be incomplete');
const out = [];
for (const d of list) {
  const id = d.id ?? d._id;
  const active = ${JSON.stringify(type)} === 'Combat' ? (await foundry.get('Combat', id)).active === true : false;
  out.push([id, String(d.name ?? ''), active]);
}
return out;`;

async function takeSnapshot(s: McpSession): Promise<Snapshot> {
  const rows: Array<DocRef & { active: boolean }> = [];
  for (const type of SNAPSHOT_TYPES) {
    const res = await s.call('foundry_script', {
      action: 'run',
      code: snapshotCode(type),
      dry_run: false,
    });
    if (res.isError) throw new Error(`snapshot of ${type} failed: ${res.text.slice(0, 400)}`);
    const list = parseScriptResult<unknown>(res.text);
    if (!Array.isArray(list)) {
      throw new Error(`snapshot of ${type} returned no array: ${res.text.slice(0, 200)}`);
    }
    for (const [id, name, active] of list as Array<[string, string, boolean]>) {
      rows.push({ type, id, name, active });
    }
  }
  const summary = await s.call('foundry_world', { action: 'summary' });
  const messages = /\*\*messages\*\*: (\d+)/.exec(summary.text);
  if (!messages?.[1]) throw new Error(`no message count in world summary: ${summary.text.slice(0, 200)}`);
  return {
    messageCount: Number(messages[1]),
    docs: rows.map(({ type, id, name }) => ({ type, id, name })),
    activeCombats: rows.filter((r) => r.type === 'Combat' && r.active).map((r) => r.id),
  };
}

async function baselineLog(s: McpSession): Promise<Set<string>> {
  const res = await s.call('foundry_history', { action: 'log', limit: 100 });
  if (res.isError) throw new Error(`history log failed: ${res.text.slice(0, 300)}`);
  return new Set(parseWriteLog(res.text).map((e) => e.id));
}

/** Run a foundry_script that creates one test document; returns its id. */
async function createViaScript(
  ctx: Ctx,
  type: string,
  data: Record<string, unknown>,
): Promise<string> {
  assert(data.name === TEST_NAME, 'refusing to create a document not named exactly the test name');
  const created = await ctx.script<Array<{ id?: string; name?: string }>>(
    `const r = await foundry.create(${JSON.stringify(type)}, [${JSON.stringify(data)}]);
return r.map(d => ({ id: d.id ?? d._id, name: d.name }));`,
  );
  const id = created[0]?.id;
  assert(id, `${type} create returned no id: ${JSON.stringify(created)}`);
  assert(created[0]?.name === TEST_NAME, `${type} created with unexpected name`);
  ctx.st.owned.add(id as string);
  return id as string;
}

const STEPS: Step[] = [
  {
    name: 'create_actor',
    desc: 'create test NPC actor via foundry_script',
    run: async (ctx) => {
      ctx.st.actorId = await createViaScript(ctx, 'Actor', {
        name: TEST_NAME,
        type: 'npc',
        system: { attributes: { hp: { value: 20, max: 20, temp: 0 } } },
        prototypeToken: { actorLink: false, width: 1, height: 1 },
      });
      return `actor ${ctx.st.actorId}`;
    },
  },
  {
    name: 'create_scene',
    desc: 'create test scene via foundry_script',
    run: async (ctx) => {
      ctx.st.sceneId = await createViaScript(ctx, 'Scene', {
        name: TEST_NAME,
        active: false,
        navigation: false,
        width: 1000,
        height: 800,
        padding: 0,
        grid: { size: 100, distance: 5, units: 'ft' },
      });
      return `scene ${ctx.st.sceneId}`;
    },
  },
  {
    name: 'place_group',
    desc: 'tokens_edit place_group (unlinked token of the test actor)',
    requires: ['create_actor', 'create_scene'],
    run: async (ctx) => {
      await ctx.ok('foundry_tokens_edit', {
        action: 'place_group',
        scene: ctx.st.sceneId,
        actors: [{ ref: ctx.st.actorId, count: 1 }],
        area: { x: 0, y: 0, width: 4, height: 4 },
      });
      const tokens = await ctx.script<Array<{ id: string; actorId: string }>>(
        `const s = await foundry.get('Scene', ${JSON.stringify(ctx.st.sceneId)});
const list = Array.isArray(s.tokens) ? s.tokens : Object.values(s.tokens ?? {});
return list.map(t => ({ id: t.id ?? t._id, actorId: t.actorId }));`,
      );
      const mine = tokens.find((t) => t.actorId === ctx.st.actorId);
      assert(mine?.id, `placed token not found on scene: ${JSON.stringify(tokens)}`);
      ctx.st.tokenId = mine?.id as string;
      ctx.st.owned.add(mine?.id as string);
      return `token ${ctx.st.tokenId}`;
    },
  },
  {
    name: 'fit_grid',
    desc: 'scenes_edit fit_grid on the test scene',
    requires: ['create_scene'],
    run: async (ctx) => {
      const r = await ctx.ok('foundry_scenes_edit', {
        action: 'fit_grid',
        scene: ctx.st.sceneId,
        cells_x: 10,
      });
      return r.text.split('\n')[0]?.slice(0, 120);
    },
  },
  {
    name: 'token_hp',
    desc: 'damage 7, set_temp_hp 5, heal 3 on the unlinked token',
    requires: ['place_group'],
    run: async (ctx) => {
      const target = ctx.st.tokenId as string;
      assert(ctx.st.owned.has(target), 'token is not owned by this run');
      const base = { target, sceneId: ctx.st.sceneId };
      await ctx.ok('foundry_actors_edit', { action: 'damage', amount: 7, ...base });
      await ctx.ok('foundry_actors_edit', { action: 'set_temp_hp', amount: 5, ...base });
      await ctx.ok('foundry_actors_edit', { action: 'heal', amount: 3, ...base });
      return 'applied (expect hp 16, temp 5)';
    },
  },
  {
    name: 'hp_persisted',
    desc: 'fresh session reads back token HP; base actor HP unchanged',
    requires: ['token_hp'],
    run: async (ctx) => {
      const fresh = await ctx.freshSession();
      try {
        const res = await fresh.call('foundry_script', {
          action: 'run',
          dry_run: false,
          code: `const s = await foundry.get('Scene', ${JSON.stringify(ctx.st.sceneId)});
const list = Array.isArray(s.tokens) ? s.tokens : Object.values(s.tokens ?? {});
const t = list.find(t => (t.id ?? t._id) === ${JSON.stringify(ctx.st.tokenId)});
const a = await foundry.get('Actor', ${JSON.stringify(ctx.st.actorId)});
return { token: t ?? null, actor: a ?? null };`,
        });
        assert(!res.isError, `fresh read failed: ${res.text.slice(0, 300)}`);
        const { token, actor } = parseScriptResult<{ token: unknown; actor: unknown }>(res.text);
        assert(token, 'token not found from a fresh session');
        const hp = extractHp(token);
        assert(hp, 'no hp found on the token delta (not persisted?)');
        assert(hp?.value === 16, `token hp.value is ${hp?.value}, expected 16 (delta not saved?)`);
        assert(hp?.temp === 5, `token hp.temp is ${hp?.temp}, expected 5`);
        const base = extractHp(actor);
        assert(base?.value === 20, `base actor hp changed to ${base?.value}, expected 20`);
        return 'token 16 hp / 5 temp persisted, base actor still 20';
      } finally {
        fresh.close();
      }
    },
  },
  {
    name: 'undo_hp',
    desc: 'undo damage on a token with an hp override (restores it) and on a fresh token without one (override removed)',
    requires: ['hp_persisted'],
    run: async (ctx) => {
      const sceneId = ctx.st.sceneId as string;
      const readToken = async (tokenId: string) => {
        const fresh = await ctx.freshSession();
        try {
          const res = await fresh.call('foundry_script', {
            action: 'run',
            dry_run: false,
            code: `const s = await foundry.get('Scene', ${JSON.stringify(sceneId)});
const list = Array.isArray(s.tokens) ? s.tokens : Object.values(s.tokens ?? {});
const t = list.find(t => (t.id ?? t._id) === ${JSON.stringify(tokenId)});
const a = await foundry.get('Actor', ${JSON.stringify(ctx.st.actorId)});
return { token: t ?? null, delta: t?.delta ?? null, actor: a ?? null };`,
          });
          assert(!res.isError, `fresh read failed: ${res.text.slice(0, 300)}`);
          const r = parseScriptResult<{ token: unknown; delta: unknown; actor: unknown }>(res.text);
          assert(r.token, `token ${tokenId} not found from a fresh session`);
          return r;
        } finally {
          fresh.close();
        }
      };
      const damageAndUndo = async (target: string): Promise<string> => {
        assert(ctx.st.owned.has(target), 'token is not owned by this run');
        await ctx.ok('foundry_actors_edit', { action: 'damage', amount: 3, target, sceneId });
        const log = await ctx.s.call('foundry_history', { action: 'log', limit: 20 });
        assert(!log.isError, `history log failed: ${log.text.slice(0, 300)}`);
        const write = parseWriteLog(log.text).find(
          (e) => e.type === 'ActorDelta' && e.action === 'update' && !e.undone && !e.undoOf,
        );
        assert(write, 'the damage write (ActorDelta update) is not in the history log');
        await ctx.ok('foundry_history_edit', { action: 'undo', write_id: write?.id });
        return write?.id as string;
      };

      // (1) a token that already has an hp override: undo restores the previous override.
      const first = ctx.st.tokenId as string;
      const before = extractHp((await readToken(first)).token)?.value;
      assert(typeof before === 'number', 'no token hp before the damage');
      const w1 = await damageAndUndo(first);
      const after = extractHp((await readToken(first)).token)?.value;
      assert(after === before, `hp after undo is ${after}, expected ${before}`);

      // (2) a fresh token with no hp override: undo REMOVES the override (does not write the base).
      await ctx.ok('foundry_tokens_edit', {
        action: 'place_group',
        scene: sceneId,
        actors: [{ ref: ctx.st.actorId, count: 1 }],
        area: { x: 0, y: 5, width: 3, height: 3 },
      });
      const tokens = await ctx.script<Array<{ id: string; actorId: string }>>(
        `const s = await foundry.get('Scene', ${JSON.stringify(sceneId)});
const list = Array.isArray(s.tokens) ? s.tokens : Object.values(s.tokens ?? {});
return list.map(t => ({ id: t.id ?? t._id, actorId: t.actorId }));`,
      );
      const second = tokens.find((t) => t.actorId === ctx.st.actorId && t.id !== first);
      assert(second?.id, `second token not found on scene: ${JSON.stringify(tokens)}`);
      ctx.st.token2Id = second?.id as string;
      ctx.st.owned.add(second?.id as string);
      const pre = await readToken(second?.id as string);
      assert(!deltaHasHpValue(pre.delta), 'fresh token unexpectedly already has an hp override');
      const baseBefore = extractHp(pre.actor)?.value;
      const w2 = await damageAndUndo(second?.id as string);
      const post = await readToken(second?.id as string);
      assert(
        !deltaHasHpValue(post.delta),
        `token delta still has system.attributes.hp.value after undo: ${JSON.stringify(post.delta).slice(0, 200)}`,
      );
      const baseAfter = extractHp(post.actor)?.value;
      assert(baseAfter === baseBefore, `base actor hp changed ${baseBefore} -> ${baseAfter}`);
      return `override ${before} restored (${w1}); fresh token override removed, base hp still ${baseAfter} (${w2})`;
    },
  },
  {
    name: 'request_rest',
    desc: 'actors_edit request_rest for the test actor',
    requires: ['create_actor'],
    run: async (ctx) => {
      const r = await ctx.ok('foundry_actors_edit', {
        action: 'request_rest',
        type: 'short',
        actors: [ctx.st.actorId],
      });
      const id = extractMessageId(r.text);
      if (id) ctx.st.chatIds.push(id);
      else ctx.st.unparsedChat.push('request_rest chat card');
      return id ? `card ${id}` : 'card posted (no id printed)';
    },
  },
  {
    name: 'tables',
    desc: 'create_table (no replacement), draw x3 distinct, 4th refused, reset_table',
    run: async (ctx) => {
      await ctx.ok('foundry_tables_edit', {
        action: 'create_table',
        name: TEST_NAME,
        replacement: false,
        results: [
          { text: 'MCPROW-A', range: [1, 1] },
          { text: 'MCPROW-B', range: [2, 2] },
          { text: 'MCPROW-C', range: [3, 3] },
        ],
      });
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await ctx.ok('foundry_chat_edit', { action: 'draw_table', table: TEST_NAME });
        const row = /MCPROW-[ABC]/.exec(r.text)?.[0];
        assert(row, `draw ${i + 1}: no row text in output: ${r.text.slice(0, 200)}`);
        seen.push(row as string);
        const id = extractMessageId(r.text);
        if (id) ctx.st.chatIds.push(id);
        else ctx.st.unparsedChat.push('draw_table chat message');
      }
      assert(new Set(seen).size === 3, `drawn rows repeated: ${seen.join(', ')}`);
      const fourth = await ctx.s.call('foundry_chat_edit', {
        action: 'draw_table',
        table: TEST_NAME,
      });
      assert(fourth.isError, '4th draw should fail (all rows drawn) but succeeded');
      await ctx.ok('foundry_tables_edit', { action: 'reset_table', table: TEST_NAME });
      const again = await ctx.ok('foundry_chat_edit', { action: 'draw_table', table: TEST_NAME });
      const id = extractMessageId(again.text);
      if (id) ctx.st.chatIds.push(id);
      else ctx.st.unparsedChat.push('draw_table chat message');
      return `drew ${seen.join(',')}; 4th refused; reset ok`;
    },
  },
  {
    name: 'macro',
    desc: 'world_edit create_macro (chat)',
    run: async (ctx) => {
      await ctx.ok('foundry_world_edit', {
        action: 'create_macro',
        name: TEST_NAME,
        type: 'chat',
        command: '/roll 1d6',
      });
      return 'macro created';
    },
  },
  {
    name: 'audio',
    desc: 'playlist + 2 volume-0 sounds, play A/B, stop A by name, stop playlist; nothing playing afterwards',
    run: async (ctx) => {
      const nameA = `${TEST_NAME} (sound A)`;
      const nameB = `${TEST_NAME} (sound B)`;
      const created = await ctx.ok('foundry_audio_edit', {
        action: 'create_playlist',
        name: TEST_NAME,
        mode: 'simultaneous',
      });
      const pid = extractLabeledId(created.text, 'ID');
      assert(pid, `no playlist id in output: ${created.text.slice(0, 200)}`);
      ctx.st.owned.add(pid as string);
      // volume 0 is mandatory: playback reaches every connected client.
      for (const [name, path] of [
        [nameA, 'sounds/dice.wav'],
        [nameB, 'sounds/notify.wav'],
      ] as const) {
        await ctx.ok('foundry_audio_edit', {
          action: 'add_sound',
          playlist: pid,
          name,
          path,
          volume: 0,
        });
      }
      const rows = async (): Promise<string> => {
        const r = await ctx.ok('foundry_audio', { action: 'list', playlist: pid });
        return r.text;
      };
      const rowOf = (text: string, name: string) => text.split('\n').find((l) => l.includes(`**${name}**`));
      const detail0 = await rows();
      assert(rowOf(detail0, nameA) && rowOf(detail0, nameB), `sounds not listed: ${detail0.slice(0, 300)}`);
      assert(/vol 0\b/.test(rowOf(detail0, nameA) ?? ''), 'sound A volume is not 0');

      await ctx.ok('foundry_audio_edit', { action: 'play', playlist: pid, sound: nameA });
      await ctx.ok('foundry_audio_edit', { action: 'play', playlist: pid, sound: nameB });
      const both = await rows();
      assert(rowOf(both, nameA)?.includes('PLAYING'), 'sound A is not playing');
      assert(rowOf(both, nameB)?.includes('PLAYING'), 'sound B is not playing');

      // Regression: a playlist update used to wipe cached sound names, so stop-by-name failed.
      const stopA = await ctx.ok('foundry_audio_edit', { action: 'stop', playlist: pid, sound: nameA });
      assert(stopA.text.includes(nameA), `stop by name output lacks the sound name: ${stopA.text.slice(0, 200)}`);
      const afterA = await rows();
      assert(!rowOf(afterA, nameA)?.includes('PLAYING'), 'sound A still playing after stop');
      assert(rowOf(afterA, nameB)?.includes('PLAYING'), 'sound B stopped too (should still play)');

      await ctx.ok('foundry_audio_edit', { action: 'stop', playlist: pid });
      const end = await rows();
      assert(!end.includes('PLAYING'), `something still playing: ${end.slice(0, 300)}`);
      const all = await ctx.ok('foundry_audio', { action: 'list', query: TEST_NAME });
      assert(!all.text.includes('PLAYING'), 'playlist list still shows PLAYING');
      return 'A/B played, A stopped by name, playlist stopped, nothing playing';
    },
  },
  {
    name: 'journal',
    desc: 'journals_edit create with one page, replace the page, read back via foundry_journals',
    run: async (ctx) => {
      const created = await ctx.ok('foundry_journals_edit', {
        action: 'create',
        name: TEST_NAME,
        pages: [{ name: 'Page one', content: '<p>smoke-first</p>' }],
      });
      const jid = extractLabeledId(created.text, 'ID');
      assert(jid, `no journal id in output: ${created.text.slice(0, 200)}`);
      ctx.st.owned.add(jid as string);
      const g1 = await ctx.ok('foundry_journals', { action: 'get', journalId: jid });
      assert(g1.text.includes('smoke-first'), `created page text missing: ${g1.text.slice(0, 300)}`);
      await ctx.ok('foundry_journals_edit', {
        action: 'replace_page',
        journal: jid,
        page: 'Page one',
        content: '<p>smoke-second</p>',
      });
      const g2 = await ctx.ok('foundry_journals', { action: 'get', journalId: jid });
      assert(g2.text.includes('smoke-second'), `updated text missing: ${g2.text.slice(0, 300)}`);
      assert(!g2.text.includes('smoke-first'), 'old page text still present');
      return `journal ${jid} page updated`;
    },
  },
  {
    name: 'effects',
    desc: 'effects_edit create / disable / enable / delete on the test actor, read back',
    requires: ['create_actor'],
    run: async (ctx) => {
      const actor = ctx.st.actorId as string;
      const created = await ctx.ok('foundry_effects_edit', {
        action: 'create',
        actor,
        name: TEST_NAME,
        changes: [{ key: 'system.attributes.ac.bonus', type: 'add', value: 1 }],
      });
      const eid = extractLabeledId(created.text, 'ID');
      assert(eid, `no effect id in output: ${created.text.slice(0, 200)}`);
      ctx.st.owned.add(eid as string);
      const effectLine = async (): Promise<string | undefined> => {
        const l = await ctx.ok('foundry_effects_edit', { action: 'list', actor });
        return l.text.split('\n').find((x) => x.includes(eid as string));
      };
      const l1 = await effectLine();
      assert(l1 && !l1.includes('disabled'), `effect not listed as enabled: ${l1}`);
      await ctx.ok('foundry_effects_edit', { action: 'update', actor, effect: eid, disabled: true });
      assert((await effectLine())?.includes('disabled'), 'effect not disabled after update');
      await ctx.ok('foundry_effects_edit', { action: 'update', actor, effect: eid, disabled: false });
      const l3 = await effectLine();
      assert(l3 && !l3.includes('disabled'), 'effect not re-enabled');
      // foundry_actors get must still work with an effect on the actor.
      await ctx.ok('foundry_actors', { action: 'get', actorId: actor });
      const viaScript = await ctx.script<Array<{ id: string; name: string }>>(
        `const a = await foundry.get('Actor', ${JSON.stringify(actor)});
const fx = Array.isArray(a.effects) ? a.effects : Object.values(a.effects ?? {});
return fx.map(e => ({ id: e.id ?? e._id, name: e.name }));`,
      );
      assert(viaScript.some((e) => e.id === eid), `effect not on the actor document: ${JSON.stringify(viaScript)}`);
      await ctx.ok('foundry_effects_edit', { action: 'delete', actor, effect: eid });
      assert((await effectLine()) === undefined, 'effect still listed after delete');
      return `effect ${eid} created, toggled, deleted`;
    },
  },
  {
    name: 'items',
    desc: 'items_edit add_to_actor / update_on_actor (item name shown) / remove_from_actor',
    requires: ['create_actor'],
    run: async (ctx) => {
      const actorId = ctx.st.actorId as string;
      const added = await ctx.ok('foundry_items_edit', {
        action: 'add_to_actor',
        actorId,
        source: { type: 'inline', item: { type: 'loot', name: TEST_NAME, system: {} } },
      });
      const iid = extractLabeledId(added.text, 'Item ID');
      assert(iid, `no item id in output: ${added.text.slice(0, 200)}`);
      ctx.st.owned.add(iid as string);
      const countItems = async (): Promise<number> => {
        const r = await ctx.script<Array<{ id: string }>>(
          `const a = await foundry.get('Actor', ${JSON.stringify(actorId)});
const items = Array.isArray(a.items) ? a.items : Object.values(a.items ?? {});
return items.filter(i => i.name === ${JSON.stringify(TEST_NAME)}).map(i => ({ id: i.id ?? i._id }));`,
        );
        return r.filter((x) => x.id === iid).length;
      };
      assert((await countItems()) === 1, 'item not found on the actor after add');
      const upd = await ctx.ok('foundry_items_edit', {
        action: 'update_on_actor',
        actorId,
        itemId: iid,
        patch: { description: { value: '<p>smoke</p>' } },
      });
      // Regression: the output used to read "undefined (undefined)".
      assert(upd.text.includes(`**Item:** ${TEST_NAME}`), `update output lacks the item name: ${upd.text.slice(0, 200)}`);
      assert(!upd.text.includes('undefined'), `update output contains "undefined": ${upd.text.slice(0, 200)}`);
      await ctx.ok('foundry_items_edit', { action: 'remove_from_actor', actorId, itemId: iid });
      assert((await countItems()) === 0, 'item still on the actor after remove');
      return `item ${iid} added, updated, removed`;
    },
  },
  {
    name: 'canvas',
    desc: 'canvas_edit add 2 walls + a region on the test scene, list with offset paging, delete them',
    requires: ['create_scene'],
    run: async (ctx) => {
      const scene = ctx.st.sceneId as string;
      const w = await ctx.ok('foundry_canvas_edit', {
        action: 'add_walls',
        scene,
        walls: [
          { x1: 1, y1: 1, x2: 4, y2: 1 },
          { x1: 1, y1: 2, x2: 4, y2: 2 },
        ],
      });
      const wallIds = extractBacktickIds(w.text);
      assert(wallIds.length === 2, `expected 2 wall ids, got ${wallIds.length}: ${w.text.slice(0, 200)}`);
      const rg = await ctx.ok('foundry_canvas_edit', {
        action: 'add_region',
        scene,
        name: TEST_NAME,
        shapes: [{ type: 'rectangle', x: 5, y: 1, width: 2, height: 2 }],
      });
      const regionId = extractLabeledId(rg.text, 'ID');
      assert(regionId, `no region id in output: ${rg.text.slice(0, 200)}`);

      const p1 = await ctx.ok('foundry_canvas', { action: 'list', scene, kind: 'walls', limit: 1, offset: 0 });
      const p2 = await ctx.ok('foundry_canvas', { action: 'list', scene, kind: 'walls', limit: 1, offset: 1 });
      const f1 = parsePageFooter(p1.text);
      const f2 = parsePageFooter(p2.text);
      assert(f1?.total === 2 && f1.nextOffset === 1, `page 1 footer unexpected: ${p1.text.slice(-120)}`);
      assert(f2?.from === 2 && f2.nextOffset === undefined, `page 2 footer unexpected: ${p2.text.slice(-120)}`);
      const seen = [...extractBacktickIds(p1.text), ...extractBacktickIds(p2.text)].sort();
      assert(seen.join() === [...wallIds].sort().join(), `paged ids ${seen} differ from created ${wallIds}`);

      const regions = await ctx.ok('foundry_canvas', { action: 'list', scene, kind: 'regions' });
      assert(regions.text.includes(regionId as string), 'region not listed');

      await ctx.ok('foundry_canvas_edit', { action: 'remove_walls', scene, walls: wallIds });
      await ctx.ok('foundry_canvas_edit', { action: 'remove_region', scene, region: regionId });
      const w0 = await ctx.ok('foundry_canvas', { action: 'list', scene, kind: 'walls' });
      const r0 = await ctx.ok('foundry_canvas', { action: 'list', scene, kind: 'regions' });
      assert(extractBacktickIds(w0.text).length === 0, `walls remain: ${w0.text.slice(0, 200)}`);
      assert(!r0.text.includes(regionId as string), 'region remains after remove');
      return '2 walls + region added, paged 1+1, removed';
    },
  },
  {
    name: 'combat_edit',
    desc: 'combat_edit start (test scene token), next_turn, end; previously active combat is active again',
    requires: ['place_group'],
    run: async (ctx) => {
      const activeCombats = () =>
        ctx.script<string[]>(
          `const list = await foundry.list('Combat', { limit: 200 });
const out = [];
for (const d of list) { const c = await foundry.get('Combat', d.id ?? d._id); if (c.active === true) out.push(c.id ?? c._id ?? d.id ?? d._id); }
return out.sort();`,
        );
      const before = await activeCombats();
      const started = await ctx.ok('foundry_combat_edit', {
        action: 'start',
        sceneId: ctx.st.sceneId,
        tokenIds: [ctx.st.tokenId],
      });
      const cid = extractLabeledId(started.text, 'Encounter');
      assert(cid, `no encounter id in output: ${started.text.slice(0, 200)}`);
      ctx.st.owned.add(cid as string);
      // Guard: end/next_turn act on "the active combat"; make sure that is OURS before touching it.
      const state = await ctx.ok('foundry_combat', { action: 'state' });
      assert(
        state.text.includes(TEST_NAME),
        `active combat is not the test combat; refusing next_turn/end. State: ${state.text.slice(0, 300)}`,
      );
      const turn = await ctx.ok('foundry_combat_edit', { action: 'next_turn' });
      assert(/Round/.test(turn.text), `next_turn output unexpected: ${turn.text.slice(0, 200)}`);
      const ended = await ctx.ok('foundry_combat_edit', { action: 'end' });
      assert(ended.text.includes(cid as string), `end removed a different combat: ${ended.text.slice(0, 200)}`);
      // Deleting the active combat leaves none active (live finding); `end` re-activates
      // the combats its `start` switched off.
      if (before.length > 0) {
        assert(ended.text.includes('Re-activated combat'), `end did not re-activate: ${ended.text.slice(0, 300)}`);
      }
      const after = await activeCombats();
      assert(!after.includes(cid as string), 'test combat still exists after end');
      assert(after.join() === before.join(), `active combats [${after}] differ from before [${before}]`);
      return `combat ${cid} started, advanced, ended; active combats restored (${before.length})`;
    },
  },
  {
    name: 'encounter',
    desc: 'generate encounter (read-only) finds monsters',
    run: async (ctx) => {
      const r = await ctx.ok('foundry_generate', { action: 'encounter', difficulty: 'moderate', seed: 1 });
      const creatures = extractCreatures(r.text);
      assert(creatures.length > 0, `no creatures in encounter output: ${r.text.slice(0, 300)}`);
      ctx.st.creatures = creatures;
      return `${creatures.length} creature entr${creatures.length === 1 ? 'y' : 'ies'} in option 1`;
    },
  },
  {
    name: 'place_encounter',
    desc: 'tokens_edit place_encounter (2 creatures, start_combat) on the test scene',
    requires: ['create_scene', 'encounter'],
    run: async (ctx) => {
      const first = ctx.st.creatures?.[0];
      assert(first, 'no creatures from the encounter step');
      const two = ctx.st.creatures?.length
        ? ctx.st.creatures.length > 1
          ? ctx.st.creatures.slice(0, 2).map((c) => ({ uuid: c.uuid, count: 1 }))
          : [{ uuid: (first as { uuid: string }).uuid, count: 2 }]
        : [];
      await ctx.ok('foundry_tokens_edit', {
        action: 'place_encounter',
        scene: ctx.st.sceneId,
        creatures: two,
        // Right of the place_group token; big enough for a Gargantuan (4×4) boss.
        area: { x: 4, y: 0, width: 6, height: 8 },
        spacing: 0,
        start_combat: true,
      });
      ctx.st.encounterPlaced = true;
      return 'placed, combat started';
    },
  },
];

async function main(): Promise<number> {
  const args = parseSmokeArgs(process.argv.slice(2));
  if (args.help) {
    say(HELP);
    return 0;
  }
  const selected = resolveSteps(STEPS, args.only);
  const env = loadServerEnv();

  say('Live smoke suite');
  say(`  Writes to the REAL Foundry world, only documents named "${TEST_NAME}"`);
  say('  (plus actors/folder imported by place_encounter), and undoes all of it.');
  say(`  Steps: ${selected.join(', ')}`);
  if (env.FOUNDRY_WRITE_ENABLED !== 'true') {
    console.error('Refusing to run: FOUNDRY_WRITE_ENABLED is not "true" in the server env.');
    return 2;
  }
  if (!args.yes) {
    console.error('Refusing to run without --yes.');
    return 2;
  }
  const serverEnv = { ...env, FOUNDRY_TOOLSETS: ALL_TOOLSETS.join(',') };

  const s = await McpSession.start(serverEnv, { clientName: 'live-smoke' });
  const sessions: McpSession[] = [s];
  let aborted = false;
  let sigints = 0;
  process.on('SIGINT', () => {
    sigints++;
    if (sigints > 1) {
      console.error('\nSecond Ctrl-C: exiting without cleanup!');
      process.exit(130);
    }
    aborted = true;
    console.error('\nInterrupted: finishing the current call, then cleaning up (Ctrl-C again to force quit).');
  });

  const st: State = { chatIds: [], unparsedChat: [], owned: new Set() };
  const ctx: Ctx = {
    s,
    st,
    ok: async (name, a) => {
      const r = await s.call(name, a);
      if (r.isError) throw new Error(`${name} ${String(a.action ?? '')} failed: ${r.text.slice(0, 400)}`);
      return r;
    },
    script: async <T>(code: string) => {
      const r = await s.call('foundry_script', { action: 'run', code, dry_run: false });
      if (r.isError) throw new Error(`script failed: ${r.text.slice(0, 400)}`);
      return parseScriptResult<T>(r.text);
    },
    freshSession: async () => {
      const f = await McpSession.start(serverEnv, { clientName: 'live-smoke-fresh' });
      sessions.push(f);
      return f;
    },
  };

  const results: Array<{ name: string; status: 'PASS' | 'FAIL' | 'SKIP'; note: string }> = [];
  let before: Snapshot | undefined;
  let baseline: Set<string> | undefined;
  let exit = 0;

  try {
    // Preflight: tools present, no leftovers, baselines for cleanup.
    const tools = new Set(await s.listTools());
    const need = ['foundry_script', 'foundry_tokens_edit', 'foundry_tables_edit', 'foundry_history_edit'];
    const missing = need.filter((t) => !tools.has(t));
    if (missing.length) {
      throw new Error(`Server is missing tools (write disabled?): ${missing.join(', ')}`);
    }
    before = await takeSnapshot(s);
    const leftovers = findLeftovers(before.docs);
    const search = await s.call('foundry_world', { action: 'search', query: TEST_PREFIX });
    if (leftovers.length > 0 || search.text.includes(TEST_NAME)) {
      console.error(`Aborting: ${TEST_PREFIX} documents already exist (leftovers from an earlier run):`);
      for (const d of leftovers) console.error(`  ${d.type} ${d.id} ${d.name}`);
      if (leftovers.length === 0) console.error(search.text);
      before = undefined; // nothing to clean up, we wrote nothing
      return 2;
    }
    baseline = await baselineLog(s);
    say(`\nBaseline: ${before.docs.length} docs, ${before.activeCombats.length} active combat(s), ${before.messageCount} chat messages.\n`);

    const failed = new Set<string>();
    for (const step of STEPS.filter((x) => selected.includes(x.name))) {
      if (aborted) {
        results.push({ name: step.name, status: 'SKIP', note: 'interrupted' });
        continue;
      }
      const blocker = (step.requires ?? []).find((r) => failed.has(r));
      if (blocker) {
        failed.add(step.name);
        results.push({ name: step.name, status: 'SKIP', note: `needs ${blocker}, which failed` });
        say(`SKIP ${step.name}: needs ${blocker}`);
        continue;
      }
      try {
        const note = (await step.run(ctx)) ?? '';
        results.push({ name: step.name, status: 'PASS', note });
        say(`PASS ${step.name}: ${note}`);
      } catch (err) {
        failed.add(step.name);
        const note = err instanceof Error ? err.message : String(err);
        results.push({ name: step.name, status: 'FAIL', note });
        say(`FAIL ${step.name}: ${note}`);
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    exit = 2;
  } finally {
    // Cleanup runs even after failure / Ctrl-C. Skipped only if nothing was written.
    if (before && baseline) {
      const ok = await cleanup(s, st, before, baseline);
      if (!ok) exit = 1;
    }
    for (const x of sessions) x.close();
  }

  say('\nSummary');
  for (const r of results) say(`  ${r.status}  ${r.name}${r.note ? `  ${r.note}` : ''}`);
  if (results.some((r) => r.status === 'FAIL')) exit = exit || 1;
  say(exit === 0 ? '\nALL PASSED' : '\nFAILED');
  return exit;
}

/** Undo everything this run wrote and verify the world is back to the baseline. */
async function cleanup(
  s: McpSession,
  st: State,
  before: Snapshot,
  baseline: Set<string>,
): Promise<boolean> {
  say('\nCleanup');
  let clean = true;
  const failures: string[] = [];

  for (let round = 0; round < 6; round++) {
    const log = await s.call('foundry_history', { action: 'log', limit: 100 });
    if (log.isError) {
      failures.push(`cannot read write log: ${log.text.slice(0, 200)}`);
      break;
    }
    const todo = newUndoable(baseline, parseWriteLog(log.text));
    if (todo.length === 0) break;
    let progress = false;
    for (const e of todo) {
      const r = await s.call('foundry_history_edit', { action: 'undo', write_id: e.id });
      if (r.isError) {
        failures.push(`undo ${e.id} (${e.action} ${e.type}: ${e.names.join(', ')}): ${r.text.slice(0, 200)}`);
        baseline.add(e.id); // do not retry forever
      } else {
        progress = true;
        say(`  undid ${e.id} (${e.action} ${e.type}: ${e.names.join(', ')})`);
      }
    }
    if (!progress) break;
  }

  // Chat messages we posted and parsed ids for (best effort: undo may have removed them).
  if (st.chatIds.length > 0) {
    const del = await s.call('foundry_script', {
      action: 'run',
      dry_run: false,
      code: `const out = [];
for (const id of ${JSON.stringify(st.chatIds)}) {
  try { await foundry.delete('ChatMessage', [id]); out.push(id); } catch (e) { /* already gone */ }
}
return out;`,
    });
    say(`  chat messages: ${del.isError ? `delete failed (${del.text.slice(0, 120)})` : 'deleted/absent'}`);
  }

  // Verify against the baseline.
  let after: Snapshot | undefined;
  try {
    after = await takeSnapshot(s);
  } catch (err) {
    failures.push(`verification snapshot failed: ${err instanceof Error ? err.message : err}`);
  }
  if (after) {
    const leftovers = [...findLeftovers(after.docs), ...newDocs(before.docs, after.docs)];
    const uniq = new Map(leftovers.map((d) => [`${d.type}:${d.id}`, d]));
    for (const d of uniq.values()) failures.push(`LEFT BEHIND: ${d.type} ${d.id} "${d.name}"`);
    for (const d of missingDocs(before.docs, after.docs)) {
      failures.push(`MISSING (was there before): ${d.type} ${d.id} "${d.name}"`);
    }
    const a = [...after.activeCombats].sort().join(',');
    const b = [...before.activeCombats].sort().join(',');
    if (a !== b) failures.push(`active combat differs: before [${b}] after [${a}]`);
    const combatBefore = before.docs.filter((d) => d.type === 'Combat').map((d) => d.id).sort().join(',');
    const combatAfter = after.docs.filter((d) => d.type === 'Combat').map((d) => d.id).sort().join(',');
    if (combatBefore !== combatAfter) failures.push('Combat id set differs from before the run');
    if (after.messageCount !== before.messageCount) {
      const unparsed = st.unparsedChat.length > 0 ? ` (no id printed for: ${st.unparsedChat.join('; ')})` : '';
      failures.push(
        `chat log has ${after.messageCount} messages, ${before.messageCount} before the run${unparsed}`,
      );
    }
  }
  const search = await s.call('foundry_world', { action: 'search', query: TEST_PREFIX });
  if (search.text.includes(TEST_NAME)) failures.push(`world search still finds test docs:\n${search.text}`);

  if (failures.length > 0) {
    clean = false;
    console.error('\nCLEANUP INCOMPLETE. A human must check/delete:');
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    say('  world is back to the baseline (docs, combats, chat count, search clean)');
  }
  return clean;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
