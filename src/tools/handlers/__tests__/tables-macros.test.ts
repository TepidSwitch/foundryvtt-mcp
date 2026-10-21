import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldData } from '../../../foundry/types.js';
import { findCachedDocuments } from '../../../foundry/world-cache.js';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
import { handleDrawTable } from '../chat-edits.js';
import { handleCreateMacro, handleDeleteMacro, handleUpdateMacro } from '../macros.js';
import {
  handleAddResults,
  handleCreateTable,
  handleDeleteTable,
  handleRemoveResults,
  handleResetTable,
  handleUpdateTable,
} from '../tables.js';
import { rollFormula } from '../world-browse.js';

const T = 'TABLEAAAAAAAAAAA';
const R1 = 'RESULT1AAAAAAAAA';
const R2 = 'RESULT2AAAAAAAAA';

type Row = Record<string, unknown>;

function setup(opts: { replacement?: boolean; drawn?: string[] } = {}) {
  return fakeFoundry({
    world: {
      folders: [{ _id: 'TFOLDERAAAAAAAAA', name: 'Loot', type: 'RollTable' }],
      tables: [
        {
          _id: T,
          name: 'Wild Magic',
          formula: '1d4',
          replacement: opts.replacement ?? true,
          results: [
            { _id: R1, range: [1, 2], name: 'Sparkles', drawn: opts.drawn?.includes(R1) ?? false },
            { _id: R2, range: [3, 4], name: 'Frogs', drawn: opts.drawn?.includes(R2) ?? false },
          ],
        },
      ],
      macros: [{ _id: 'MACROAAAAAAAAAAA', name: 'Rest', type: 'chat' }],
    },
  });
}
type Fake = ReturnType<typeof setup>;
const table = (f: Fake) => f.world.tables?.find((t) => t._id === T) as Row;
const results = (f: Fake) => table(f).results as Row[];
const writes = (f: Fake) => f.sent.filter((s) => s.action !== 'get');

afterEach(() => vi.restoreAllMocks());

describe('rollFormula', () => {
  it('supports dN, NdM+K and dice combos', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(rollFormula('d20')?.total).toBe(20);
    expect(rollFormula('2d6+3')?.total).toBe(15);
    expect(rollFormula('1d8 + 1d6 - 2')?.total).toBe(12);
    expect(rollFormula('1d100')?.total).toBe(100);
  });
  it('rejects unsupported syntax', () => {
    expect(rollFormula('4d6kh3')).toBeNull();
    expect(rollFormula('5')).toBeNull();
    expect(rollFormula('@abilities.str.mod')).toBeNull();
    expect(rollFormula('1d20x')).toBeNull();
  });
});

describe('table writes', () => {
  it('creates a table deriving the formula from the ranges', async () => {
    const f = setup();
    await handleCreateTable(
      {
        name: 'Loot',
        folder: 'Loot',
        results: [
          { text: 'Gold', range: [1, 10] },
          { text: 'Gem', range: [11, 12] },
          { text: 'Ring' },
        ],
      },
      f.client,
    );
    const created = f.world.tables?.find((t) => t.name === 'Loot') as Row;
    expect(created.formula).toBe('1d13');
    expect(created.folder).toBe('TFOLDERAAAAAAAAA');
    expect((created.results as Array<{ range: number[] }>)[2]?.range).toEqual([13, 13]);
  });

  it('rejects overlapping ranges', async () => {
    const f = setup();
    await expect(
      handleCreateTable(
        {
          name: 'x',
          results: [
            { text: 'a', range: [1, 5] },
            { text: 'b', range: [5, 6] },
          ],
        },
        f.client,
      ),
    ).rejects.toThrow(/overlap/);
    expect(writes(f)).toEqual([]);
  });

  it('adds results after the existing ones, widens the formula, and rejects overlaps', async () => {
    const f = setup();
    await handleAddResults({ table: 'wild', results: [{ text: 'Owl' }] }, f.client);
    expect(results(f).at(-1)).toMatchObject({ range: [5, 5], name: 'Owl' });
    expect(table(f).formula).toBe('1d5');
    await expect(
      handleAddResults({ table: 'wild', results: [{ text: 'x', range: [2, 3] }] }, f.client),
    ).rejects.toThrow(/overlap/);
    expect(results(f)).toHaveLength(3);
  });

  it('updates a table and rejects an empty update', async () => {
    const f = setup({ replacement: false });
    await handleUpdateTable({ table: 'wild', replacement: true }, f.client);
    expect(table(f).replacement).toBe(true);
    await expect(handleUpdateTable({ table: 'wild' }, f.client)).rejects.toThrow(
      /Nothing to update/,
    );
  });

  it('removes results, rejecting unknown ids', async () => {
    const f = setup();
    await handleRemoveResults({ table: 'wild', results: [R2] }, f.client);
    expect(results(f).map((r) => r._id)).toEqual([R1]);
    await expect(
      handleRemoveResults({ table: 'wild', results: ['NOPEAAAAAAAAAAAA'] }, f.client),
    ).rejects.toThrow(/No result/);
  });

  it('resets drawn flags, then deletes the table', async () => {
    const f = setup({ replacement: false, drawn: [R1] });
    await handleResetTable({ table: 'wild' }, f.client);
    expect(results(f).map((r) => r.drawn)).toEqual([false, false]);
    await handleDeleteTable({ table: 'wild' }, f.client);
    expect(f.world.tables).toEqual([]);
  });
});

describe('draw_table without replacement', () => {
  it('marks the drawn row and skips already drawn rows', async () => {
    const f = setup({ replacement: false, drawn: [R1] });
    const seq = [0, 0.99]; // first roll lands on the drawn row
    vi.spyOn(Math, 'random').mockImplementation(() => seq.shift() ?? 0.99);
    const out = (await handleDrawTable({ table: 'wild' }, f.client)).content[0] as { text: string };
    expect(out.text).toContain('Frogs');
    expect(results(f).map((r) => r.drawn)).toEqual([true, true]);
  });

  it('suggests reset_table when everything is drawn', async () => {
    const f = setup({ replacement: false, drawn: [R1, R2] });
    await expect(handleDrawTable({ table: 'wild' }, f.client)).rejects.toThrow(/reset_table/);
  });

  it('does not mark anything when replacement is on', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const f = setup();
    await handleDrawTable({ table: 'wild' }, f.client);
    expect(results(f).map((r) => r.drawn)).toEqual([false, false]);
    expect(writes(f).filter((w) => w.type === 'TableResult')).toEqual([]);
  });
});

describe('macro writes', () => {
  it('creates, updates and deletes', async () => {
    const f = setup();
    await handleCreateMacro({ name: 'Hi', type: 'chat', command: 'hello' }, f.client);
    expect(f.world.macros?.find((m) => m.name === 'Hi')).toMatchObject({
      type: 'chat',
      command: 'hello',
      scope: 'global',
    });
    await handleUpdateMacro({ macro: 'rest', command: 'x' }, f.client);
    expect(f.world.macros?.find((m) => m._id === 'MACROAAAAAAAAAAA')?.command).toBe('x');
    await handleDeleteMacro({ macro: 'rest' }, f.client);
    expect(f.world.macros?.map((m) => m.name)).toEqual(['Hi']);
  });
});

describe('cache snapshots for undo', () => {
  it('finds embedded table results by parent uuid', () => {
    const world = {
      tables: [{ _id: T, results: [{ _id: R1, drawn: true }] }],
    } as unknown as WorldData;
    expect(findCachedDocuments(world, 'TableResult', [R1], `RollTable.${T}`)).toEqual([
      { _id: R1, drawn: true },
    ]);
    expect(findCachedDocuments(world, 'RollTable', [T])).toHaveLength(1);
  });
});
