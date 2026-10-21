/**
 * Pure helpers for scripts/live-smoke.ts (no I/O, unit-tested).
 */

export const TEST_NAME = 'MCP TEST — delete me';
export const TEST_PREFIX = 'MCP TEST';

export const ALL_TOOLSETS = [
  'actors',
  'items',
  'effects',
  'scenes',
  'tokens',
  'combat',
  'journals',
  'compendium',
  'audio',
  'chat',
  'world',
  'tables',
  'files',
  'generate',
  'history',
  'diagnostics',
  'canvas',
  'script',
] as const;

export interface SmokeArgs {
  yes: boolean;
  only: string[] | undefined;
  help: boolean;
}

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const out: SmokeArgs = { yes: false, only: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') {
      out.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--only' || arg?.startsWith('--only=')) {
      const raw = arg === '--only' ? argv[++i] : arg.slice('--only='.length);
      if (!raw || raw.startsWith('--')) {
        throw new Error('--only needs a comma-separated list of step names');
      }
      out.only = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

/** Selected steps plus everything they require, in the original step order. */
export function resolveSteps(
  steps: ReadonlyArray<{ name: string; requires?: readonly string[] }>,
  only: string[] | undefined,
): string[] {
  const names = new Set(steps.map((s) => s.name));
  for (const o of only ?? []) {
    if (!names.has(o)) {
      throw new Error(`Unknown step "${o}". Steps: ${[...names].join(', ')}`);
    }
  }
  if (!only) {
    return steps.map((s) => s.name);
  }
  const wanted = new Set<string>();
  const add = (n: string) => {
    if (wanted.has(n)) return;
    wanted.add(n);
    for (const r of steps.find((s) => s.name === n)?.requires ?? []) add(r);
  };
  only.forEach(add);
  return steps.map((s) => s.name).filter((n) => wanted.has(n));
}

/** The JSON after "Result: " in a foundry_script response. */
export function parseScriptResult<T = unknown>(text: string): T {
  const m = /^Result: (.*)$/m.exec(text);
  if (!m?.[1]) {
    throw new Error(`No "Result:" line in script output: ${text.slice(0, 300)}`);
  }
  return JSON.parse(m[1]) as T;
}

export interface WriteLogEntry {
  id: string;
  action: string;
  type: string;
  names: string[];
  dryRun: boolean;
  undone: boolean;
  undoOf: boolean;
}

// The names part can be empty (an unnamed Combat), and line.trim() drops its trailing space.
const LOG_LINE = /^- `([^`]+)` \S+ · (\w+) (\w+)(?: \(in [^)]*\))?(?: ·(?: (.*?))?)?(?: · _([^_]*)_)?$/;

/** Parse foundry_history log text (newest first). */
export function parseWriteLog(text: string): WriteLogEntry[] {
  const entries: WriteLogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LOG_LINE.exec(line.trim());
    if (!m) continue;
    const flags = m[5] ?? '';
    entries.push({
      id: m[1] as string,
      action: m[2] as string,
      type: m[3] as string,
      names: m[4] ? m[4].split(', ') : [],
      dryRun: /dry-run/.test(flags),
      undone: /\bundone\b/.test(flags),
      undoOf: /undo of/.test(flags),
    });
  }
  return entries;
}

/** Entries written after the baseline that still need an undo, newest first. */
export function newUndoable(
  baselineIds: ReadonlySet<string>,
  entries: readonly WriteLogEntry[],
): WriteLogEntry[] {
  return entries.filter((e) => !baselineIds.has(e.id) && !e.dryRun && !e.undone && !e.undoOf);
}

export interface DocRef {
  type: string;
  id: string;
  name: string;
}

/** Documents whose name marks them as smoke-test leftovers. */
export function findLeftovers(docs: readonly DocRef[]): DocRef[] {
  return docs.filter((d) => d.name.includes(TEST_PREFIX));
}

/** Docs in `after` whose (type,id) were not in `before`. */
export function newDocs(before: readonly DocRef[], after: readonly DocRef[]): DocRef[] {
  const seen = new Set(before.map((d) => `${d.type}:${d.id}`));
  return after.filter((d) => !seen.has(`${d.type}:${d.id}`));
}

/** Docs that were in `before` but are gone from `after`. */
export function missingDocs(before: readonly DocRef[], after: readonly DocRef[]): DocRef[] {
  return newDocs(after, before);
}

/** The "**ID:** x" a chat tool prints. */
export function extractMessageId(text: string): string | undefined {
  return /\*\*ID:\*\*\s*([A-Za-z0-9]+)/.exec(text)?.[1];
}

/** creatures array of the first option printed by foundry_generate encounter. */
export function extractCreatures(text: string): Array<{ uuid: string; count: number }> {
  const m = /place_encounter creatures: `(\[.*?\])`/.exec(text);
  if (!m?.[1]) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface Hp {
  value: number;
  temp: number | undefined;
}

function findHp(node: unknown, depth: number): Hp | undefined {
  if (!node || typeof node !== 'object' || depth > 8) return undefined;
  const rec = node as Record<string, unknown>;
  const hp = rec.hp as Record<string, unknown> | undefined;
  if (hp && typeof hp === 'object' && typeof hp.value === 'number') {
    return { value: hp.value, temp: typeof hp.temp === 'number' ? hp.temp : undefined };
  }
  for (const v of Object.values(rec)) {
    const r = findHp(v, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** First `hp` object ({value,...}) found in a document, preferring a token's delta. */
export function extractHp(doc: unknown): Hp | undefined {
  const rec = doc as Record<string, unknown> | null;
  return findHp(rec?.delta, 0) ?? findHp(doc, 0);
}

/** The id after a bold label such as "**Item ID:** x" (label without the colon). */
export function extractLabeledId(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\*\\*${escaped}:\\*\\*\\s*\`?([A-Za-z0-9]+)\`?`).exec(text)?.[1];
}

/** Every backticked 16-character Foundry id in a tool output, in order. */
export function extractBacktickIds(text: string): string[] {
  return [...text.matchAll(/`([A-Za-z0-9]{16})`/g)].map((m) => m[1] as string);
}

/** Paging footer of a list: "Showing 2–3 of 5; next offset=3". */
export function parsePageFooter(
  text: string,
): { from: number; to: number; total: number; nextOffset: number | undefined } | undefined {
  const m = /Showing (\d+)[–-](\d+) of (\d+)(?:; next offset=(\d+))?/.exec(text);
  if (!m) return undefined;
  return {
    from: Number(m[1]),
    to: Number(m[2]),
    total: Number(m[3]),
    nextOffset: m[4] === undefined ? undefined : Number(m[4]),
  };
}

/** True when a token delta carries its own hp.value override. */
export function deltaHasHpValue(delta: unknown): boolean {
  const hp = (
    (delta as { system?: { attributes?: { hp?: Record<string, unknown> } } } | null)?.system
      ?.attributes?.hp
  ) as Record<string, unknown> | undefined;
  return !!hp && hp.value !== undefined && hp.value !== null;
}
