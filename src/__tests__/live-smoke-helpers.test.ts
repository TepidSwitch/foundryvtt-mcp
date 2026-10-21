import { describe, expect, it } from 'vitest';
import {
  deltaHasHpValue,
  extractBacktickIds,
  extractCreatures,
  extractHp,
  extractLabeledId,
  extractMessageId,
  findLeftovers,
  newDocs,
  newUndoable,
  parsePageFooter,
  parseScriptResult,
  parseSmokeArgs,
  parseWriteLog,
  resolveSteps,
} from '../../scripts/lib/smoke-helpers.js';

describe('live smoke helpers', () => {
  it('parses args', () => {
    expect(parseSmokeArgs(['--yes', '--only', 'a,b'])).toEqual({
      yes: true,
      only: ['a', 'b'],
      help: false,
    });
    expect(parseSmokeArgs([]).yes).toBe(false);
    expect(() => parseSmokeArgs(['--nope'])).toThrow();
    expect(() => parseSmokeArgs(['--only'])).toThrow();
  });

  it('resolves --only with requirements', () => {
    const steps = [{ name: 'a' }, { name: 'b', requires: ['a'] }, { name: 'c' }];
    expect(resolveSteps(steps, ['b'])).toEqual(['a', 'b']);
    expect(resolveSteps(steps, undefined)).toEqual(['a', 'b', 'c']);
    expect(() => resolveSteps(steps, ['x'])).toThrow();
  });

  it('extracts ids and results', () => {
    expect(parseScriptResult('ok\nResult: [{"id":"abc"}]')).toEqual([{ id: 'abc' }]);
    expect(() => parseScriptResult('nothing')).toThrow();
    expect(extractMessageId('Posted.\n**ID:** Ab12Cd')).toBe('Ab12Cd');
    expect(
      extractCreatures(
        'x\nplace_encounter creatures: `[{"uuid":"Compendium.a.Actor.b","count":2}]`',
      ),
    ).toEqual([{ uuid: 'Compendium.a.Actor.b', count: 2 }]);
    expect(extractCreatures('none')).toEqual([]);
  });

  it('reads hp, preferring the token delta', () => {
    expect(
      extractHp({ delta: { system: { attributes: { hp: { value: 16, temp: 5 } } } } }),
    ).toEqual({ value: 16, temp: 5 });
    expect(extractHp({ system: { attributes: { hp: { value: 20 } } } })).toEqual({
      value: 20,
      temp: undefined,
    });
  });

  const log = [
    'Recent writes',
    '- `w3` 2026-01-01 · update Token · Goblin, Orc · _undone_',
    '- `w2` 2026-01-01 · create Actor (in Scene.x) · MCP TEST — delete me',
    '- `w1` 2026-01-01 · delete Actor · old · _dry-run_',
    '- `w0` 2026-01-01 · create Actor · before',
  ].join('\n');

  it('parses the write log and picks undoable entries', () => {
    const entries = parseWriteLog(log);
    expect(entries.map((e) => e.id)).toEqual(['w3', 'w2', 'w1', 'w0']);
    expect(entries[0]).toMatchObject({ names: ['Goblin', 'Orc'], undone: true });
    expect(newUndoable(new Set(['w0']), entries).map((e) => e.id)).toEqual(['w2']);
  });

  it('parses entries with no names (an unnamed Combat), as trimmed live', () => {
    // Live finding: these were skipped, so cleanup never undid combat writes.
    const entries = parseWriteLog(
      '- `w9` 2026-01-01 · create Combat ·\n- `w8` 2026-01-01 · update Combat · 1 id(s)',
    );
    expect(entries.map((e) => [e.id, e.action, e.type, e.names])).toEqual([
      ['w9', 'create', 'Combat', []],
      ['w8', 'update', 'Combat', ['1 id(s)']],
    ]);
  });

  it('detects leftovers and new documents', () => {
    const a = { type: 'Actor', id: '1', name: 'Bob' };
    const b = { type: 'Scene', id: '2', name: 'MCP TEST — delete me' };
    expect(findLeftovers([a, b])).toEqual([b]);
    expect(newDocs([a], [a, b])).toEqual([b]);
  });

  it('extracts labeled ids and backticked ids', () => {
    const t =
      '**Item:** X (loot)\n**Item ID:** abc123DEF456ghij\n**IDs:** `aaaaaaaaaaaaaaaa` `bbbbbbbbbbbbbbbb`';
    expect(extractLabeledId(t, 'Item ID')).toBe('abc123DEF456ghij');
    expect(extractLabeledId(t, 'Nope')).toBeUndefined();
    expect(extractBacktickIds(t)).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  });

  it('parses the paging footer', () => {
    expect(parsePageFooter('x\n_Showing 1–1 of 2; next offset=1._')).toEqual({
      from: 1,
      to: 1,
      total: 2,
      nextOffset: 1,
    });
    expect(parsePageFooter('_Showing 2–2 of 2._')?.nextOffset).toBeUndefined();
    expect(parsePageFooter('nothing')).toBeUndefined();
  });

  it('detects an hp override on a token delta', () => {
    expect(deltaHasHpValue({ system: { attributes: { hp: { value: 17 } } } })).toBe(true);
    expect(deltaHasHpValue({ system: { attributes: { hp: { temp: 2 } } } })).toBe(false);
    expect(deltaHasHpValue({})).toBe(false);
    expect(deltaHasHpValue(null)).toBe(false);
  });
});
