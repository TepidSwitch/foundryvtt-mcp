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
  extractCreatures,
  extractHp,
  extractMessageId,
  findLeftovers,
  missingDocs,
  newDocs,
  newUndoable,
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
}

interface State {
  actorId?: string;
  sceneId?: string;
  tokenId?: string;
  chatIds: string[];
  unparsedChat: string[];
  /** Ids of documents this run created; updates may only target these. */
  owned: Set<string>;
  creatures?: Array<{ uuid: string; count: number }>;
  encounterPlaced?: boolean;
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
Requires FOUNDRY_WRITE_ENABLED=true in the server env and --yes.`;

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
  return {
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
    name: 'encounter',
    desc: 'generate encounter (read-only) finds monsters',
    run: async (ctx) => {
      const r = await ctx.ok('foundry_generate', { action: 'encounter', difficulty: 'moderate' });
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
        area: { x: 5, y: 0, width: 5, height: 4 },
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
    say(`\nBaseline: ${before.docs.length} docs, ${before.activeCombats.length} active combat(s).\n`);

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
  }
  const search = await s.call('foundry_world', { action: 'search', query: TEST_PREFIX });
  if (search.text.includes(TEST_NAME)) failures.push(`world search still finds test docs:\n${search.text}`);

  if (st.unparsedChat.length > 0) {
    say(`  note: chat messages whose ids were not printed may remain in the chat log (${st.unparsedChat.join('; ')})`);
  }
  if (failures.length > 0) {
    clean = false;
    console.error('\nCLEANUP INCOMPLETE. A human must check/delete:');
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    say('  world is back to the baseline (docs, combats, search clean)');
  }
  return clean;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
