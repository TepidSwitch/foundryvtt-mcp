/**
 * @fileoverview RollTable editing: create/update tables and their results
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { isRec, num, type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

export interface ResultInput {
  text: string;
  range?: number[];
  weight?: number;
  documentUuid?: string;
}

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function bad(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function resultsOf(table: Rec): Rec[] {
  return (Array.isArray(table.results) ? table.results : []).filter(isRec);
}

function rangeOf(r: Rec): [number, number] | null {
  return Array.isArray(r.range) ? [num(r.range[0]), num(r.range[1])] : null;
}

/** Throws unless every range is an ascending integer pair and none overlap. */
export function validateRanges(ranges: Array<{ label: string; range: [number, number] }>): void {
  for (const { label, range } of ranges) {
    const [lo, hi] = range;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
      bad(`Range [${lo}, ${hi}] for ${label} must be two ascending integers`);
    }
  }
  const sorted = [...ranges].sort((a, b) => a.range[0] - b.range[0]);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && cur.range[0] <= prev.range[1]) {
      bad(
        `Ranges overlap: ${prev.label} [${prev.range.join(', ')}] and ${cur.label} [${cur.range.join(', ')}]`,
      );
    }
  }
}

/** Fills in missing ranges consecutively (width = weight) after `start`. */
function buildResults(inputs: ResultInput[], start: number): Rec[] {
  let next = start;
  return inputs.map((r) => {
    const weight = r.weight ?? 1;
    let range: number[] | undefined = r.range;
    if (!range) {
      range = [next, next + weight - 1];
    }
    next = Math.max(next, (range[1] ?? 0) + 1);
    const data: Rec = {
      type: r.documentUuid ? 'document' : 'text',
      name: r.text,
      weight,
      range,
      drawn: false,
    };
    if (r.documentUuid) {
      data.documentUuid = r.documentUuid;
    }
    return data;
  });
}

function maxHi(results: Rec[]): number {
  return results.reduce((m, r) => Math.max(m, rangeOf(r)?.[1] ?? 0), 0);
}

function findTable(foundryClient: FoundryClient, ref: string): Rec {
  return resolveByRef(
    snapshotOf(foundryClient).tables as Rec[],
    ref,
    'world roll table',
    'foundry_world browse kind="tables"',
  );
}

function folderId(foundryClient: FoundryClient, ref: string): string {
  const folders = (snapshotOf(foundryClient).folders as Rec[]).filter(
    (f) => str(f.type) === 'RollTable',
  );
  return str(
    resolveByRef(folders, ref, 'RollTable folder', 'foundry_world browse kind="folders"')._id,
  );
}

export async function handleCreateTable(
  args: {
    name: string;
    formula?: string;
    replacement?: boolean;
    description?: string;
    results: ResultInput[];
    folder?: string;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('create roll table', async () => {
    if (args.results.length === 0) {
      bad('results must have at least one entry');
    }
    const results = buildResults(args.results, 1);
    validateRanges(
      results.map((r, i) => ({ label: `result ${i + 1}`, range: rangeOf(r) as [number, number] })),
    );
    const data: Rec = {
      name: args.name,
      formula: args.formula ?? `1d${maxHi(results)}`,
      replacement: args.replacement ?? true,
      results,
    };
    if (args.description !== undefined) {
      data.description = args.description;
    }
    if (args.folder) {
      data.folder = folderId(foundryClient, args.folder);
    }
    const [created] = await foundryClient.createDocuments('RollTable', [data]);
    return text(
      `🎲 **Table Created** "${args.name}" (${str(data.formula)}, ${results.length} results${data.replacement === false ? ', no replacement' : ''})\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleUpdateTable(
  args: {
    table: string;
    name?: string;
    formula?: string;
    replacement?: boolean;
    displayRoll?: boolean;
    description?: string;
    folder?: string | null;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('update roll table', async () => {
    const table = findTable(foundryClient, args.table);
    const update: Rec = { _id: str(table._id) };
    for (const key of ['name', 'formula', 'replacement', 'displayRoll', 'description'] as const) {
      if (args[key] !== undefined) {
        update[key] = args[key];
      }
    }
    if (args.folder !== undefined) {
      update.folder =
        args.folder === null || args.folder === '' ? null : folderId(foundryClient, args.folder);
    }
    if (Object.keys(update).length === 1) {
      bad('Nothing to update: give name, formula, replacement, displayRoll, description or folder');
    }
    await foundryClient.updateDocuments('RollTable', [update]);
    return text(
      `🎲 **Table Updated** "${str(table.name)}": ${Object.keys(update)
        .filter((k) => k !== '_id')
        .join(', ')}\n**ID:** ${str(table._id)}`,
    );
  });
}

export async function handleAddResults(
  args: { table: string; results: ResultInput[] },
  foundryClient: FoundryClient,
) {
  return withToolError('add table results', async () => {
    const table = findTable(foundryClient, args.table);
    if (args.results.length === 0) {
      bad('results must have at least one entry');
    }
    const existing = resultsOf(table);
    const fresh = buildResults(args.results, maxHi(existing) + 1);
    validateRanges([
      ...existing.flatMap((r) => {
        const range = rangeOf(r);
        return range ? [{ label: `existing "${str(r.name).slice(0, 30)}"`, range }] : [];
      }),
      ...fresh.map((r, i) => ({
        label: `new result ${i + 1}`,
        range: rangeOf(r) as [number, number],
      })),
    ]);
    const created = await foundryClient.createDocuments(
      'TableResult',
      fresh,
      `RollTable.${str(table._id)}`,
    );
    // Widen a simple 1dN formula so the new rows can actually be rolled.
    const top = maxHi(fresh);
    const simple = str(table.formula).match(/^1d(\d+)$/i);
    let note = '';
    if (simple && top > Number(simple[1])) {
      await foundryClient.updateDocuments('RollTable', [
        { _id: str(table._id), formula: `1d${top}` },
      ]);
      note = `\nFormula widened to 1d${top}.`;
    }
    return text(
      `🎲 **Added ${fresh.length} result(s)** to "${str(table.name)}"${note}\n**IDs:** ${created.map((c) => str(c._id)).join(', ')}`,
    );
  });
}

export async function handleRemoveResults(
  args: { table: string; results: string[] },
  foundryClient: FoundryClient,
) {
  return withToolError('remove table results', async () => {
    const table = findTable(foundryClient, args.table);
    const existing = resultsOf(table);
    const ids = args.results.map((ref) => {
      const hit = existing.find((r) => r._id === ref);
      if (!hit) {
        bad(
          `No result with id "${ref}" in "${str(table.name)}"; ids: ${existing.map((r) => str(r._id)).join(', ')}`,
        );
      }
      return str(hit._id);
    });
    await foundryClient.deleteDocuments('TableResult', ids, `RollTable.${str(table._id)}`);
    return text(`🗑️ **Removed ${ids.length} result(s)** from "${str(table.name)}"`);
  });
}

export async function handleDeleteTable(args: { table: string }, foundryClient: FoundryClient) {
  return withToolError('delete roll table', async () => {
    const table = findTable(foundryClient, args.table);
    await foundryClient.deleteDocuments('RollTable', [str(table._id)]);
    return text(
      `🗑️ **Table Deleted** "${str(table.name)}" (revert with foundry_history_edit undo)\n**ID:** ${str(table._id)}`,
    );
  });
}

export async function handleResetTable(args: { table: string }, foundryClient: FoundryClient) {
  return withToolError('reset roll table', async () => {
    const table = findTable(foundryClient, args.table);
    const drawn = resultsOf(table).filter((r) => r.drawn === true);
    if (drawn.length === 0) {
      return text(`🎲 "${str(table.name)}" has no drawn results; nothing to reset`);
    }
    await foundryClient.updateDocuments(
      'TableResult',
      drawn.map((r) => ({ _id: str(r._id), drawn: false })),
      `RollTable.${str(table._id)}`,
    );
    return text(
      `🎲 **Table Reset** "${str(table.name)}": ${drawn.length} result(s) drawable again`,
    );
  });
}
