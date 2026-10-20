import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { WorldData } from '../../../foundry/types.js';
import { findCachedDocuments } from '../../../foundry/world-cache.js';
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

function client(opts: { replacement?: boolean; drawn?: string[] } = {}) {
  const snapshot = {
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
  };
  const m = {
    createDocuments: vi.fn(async () => [{ _id: 'NEWAAAAAAAAAAAAA' }]),
    updateDocuments: vi.fn(async () => []),
    deleteDocuments: vi.fn(async () => []),
  };
  return {
    mock: {
      getWorldSnapshot: () => snapshot,
      getUserId: () => 'USERGMAAAAAAAAAA',
      ...m,
    } as unknown as FoundryClient,
    ...m,
  };
}

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
    const { mock, createDocuments } = client();
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
      mock,
    );
    const data = (createDocuments.mock.calls[0] as unknown[][])[1] as Array<
      Record<string, unknown>
    >;
    expect(data[0]?.formula).toBe('1d13');
    expect(data[0]?.folder).toBe('TFOLDERAAAAAAAAA');
    expect((data[0]?.results as Array<{ range: number[] }>)?.[2]?.range).toEqual([13, 13]);
  });

  it('rejects overlapping ranges', async () => {
    const { mock, createDocuments } = client();
    await expect(
      handleCreateTable(
        {
          name: 'x',
          results: [
            { text: 'a', range: [1, 5] },
            { text: 'b', range: [5, 6] },
          ],
        },
        mock,
      ),
    ).rejects.toThrow(/overlap/);
    expect(createDocuments).not.toHaveBeenCalled();
  });

  it('adds results after the existing ones, widens the formula, and rejects overlaps', async () => {
    const { mock, createDocuments, updateDocuments } = client();
    await handleAddResults({ table: 'wild', results: [{ text: 'Owl' }] }, mock);
    expect(createDocuments).toHaveBeenCalledWith(
      'TableResult',
      [expect.objectContaining({ range: [5, 5], name: 'Owl' })],
      `RollTable.${T}`,
    );
    expect(updateDocuments).toHaveBeenCalledWith('RollTable', [{ _id: T, formula: '1d5' }]);
    await expect(
      handleAddResults({ table: 'wild', results: [{ text: 'x', range: [2, 3] }] }, mock),
    ).rejects.toThrow(/overlap/);
  });

  it('updates, removes, deletes and resets', async () => {
    const { mock, updateDocuments, deleteDocuments } = client({ replacement: false, drawn: [R1] });
    await handleUpdateTable({ table: 'wild', replacement: true }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith('RollTable', [{ _id: T, replacement: true }]);
    await expect(handleUpdateTable({ table: 'wild' }, mock)).rejects.toThrow(/Nothing to update/);
    await handleRemoveResults({ table: 'wild', results: [R2] }, mock);
    expect(deleteDocuments).toHaveBeenLastCalledWith('TableResult', [R2], `RollTable.${T}`);
    await expect(
      handleRemoveResults({ table: 'wild', results: ['NOPEAAAAAAAAAAAA'] }, mock),
    ).rejects.toThrow(/No result/);
    await handleResetTable({ table: 'wild' }, mock);
    expect(updateDocuments).toHaveBeenLastCalledWith(
      'TableResult',
      [{ _id: R1, drawn: false }],
      `RollTable.${T}`,
    );
    await handleDeleteTable({ table: 'wild' }, mock);
    expect(deleteDocuments).toHaveBeenLastCalledWith('RollTable', [T]);
  });
});

describe('draw_table without replacement', () => {
  it('marks the drawn row and skips already drawn rows', async () => {
    const { mock, updateDocuments } = client({ replacement: false, drawn: [R1] });
    const seq = [0, 0.99]; // first roll lands on the drawn row
    vi.spyOn(Math, 'random').mockImplementation(() => seq.shift() ?? 0.99);
    const out = (await handleDrawTable({ table: 'wild' }, mock)).content[0] as { text: string };
    expect(out.text).toContain('Frogs');
    expect(updateDocuments).toHaveBeenCalledWith(
      'TableResult',
      [{ _id: R2, drawn: true }],
      `RollTable.${T}`,
    );
  });

  it('suggests reset_table when everything is drawn', async () => {
    const { mock } = client({ replacement: false, drawn: [R1, R2] });
    await expect(handleDrawTable({ table: 'wild' }, mock)).rejects.toThrow(/reset_table/);
  });

  it('does not mark anything when replacement is on', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { mock, updateDocuments } = client();
    await handleDrawTable({ table: 'wild' }, mock);
    expect(updateDocuments).not.toHaveBeenCalled();
  });
});

describe('macro writes', () => {
  it('creates, updates and deletes', async () => {
    const { mock, createDocuments, updateDocuments, deleteDocuments } = client();
    await handleCreateMacro({ name: 'Hi', type: 'chat', command: 'hello' }, mock);
    expect(createDocuments).toHaveBeenCalledWith('Macro', [
      { name: 'Hi', type: 'chat', command: 'hello', scope: 'global' },
    ]);
    await handleUpdateMacro({ macro: 'rest', command: 'x' }, mock);
    expect(updateDocuments).toHaveBeenCalledWith('Macro', [
      { _id: 'MACROAAAAAAAAAAA', command: 'x' },
    ]);
    await handleDeleteMacro({ macro: 'rest' }, mock);
    expect(deleteDocuments).toHaveBeenCalledWith('Macro', ['MACROAAAAAAAAAAA']);
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
