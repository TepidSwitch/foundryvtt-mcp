import { describe, expect, it } from 'vitest';
import {
  extractCreatures,
  extractHp,
  extractMessageId,
  findLeftovers,
  newDocs,
  newUndoable,
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

  it('detects leftovers and new documents', () => {
    const a = { type: 'Actor', id: '1', name: 'Bob' };
    const b = { type: 'Scene', id: '2', name: 'MCP TEST — delete me' };
    expect(findLeftovers([a, b])).toEqual([b]);
    expect(newDocs([a], [a, b])).toEqual([b]);
  });
});
