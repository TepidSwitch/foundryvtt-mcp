import { describe, expect, it } from 'vitest';
import { runInSandbox } from '../sandbox.js';

const base = {
  timeoutMs: 2000,
  memoryBytes: 16 * 1024 * 1024,
  maxOutputChars: 2000,
  call: async (m: string, a: unknown[]) => ({ m, a }),
};

describe('sandbox', () => {
  it('returns a value and captures logs', async () => {
    const r = await runInSandbox('console.log("hi", {a:1}); return 1 + 1;', base);
    expect(r).toMatchObject({ ok: true, value: 2, logs: ['hi {"a":1}'] });
  });

  it('calls the host through foundry.*', async () => {
    const r = await runInSandbox('return await foundry.list("Actor", {query:"x"});', base);
    expect(r.value).toEqual({ m: 'list', a: ['Actor', { query: 'x' }] });
  });

  it('propagates host errors as catchable exceptions', async () => {
    const r = await runInSandbox(
      'try { await foundry.get("A","b"); } catch (e) { return e.message; }',
      {
        ...base,
        call: async () => {
          throw new Error('nope');
        },
      },
    );
    expect(r.value).toBe('nope');
  });

  it.each([
    'typeof process',
    'typeof require',
    'typeof fetch',
    'typeof globalThis.process',
    'typeof XMLHttpRequest',
    'typeof WebAssembly',
    'typeof setTimeout',
  ])('has no ambient capability: %s', async (expr) => {
    const r = await runInSandbox(`return ${expr};`, base);
    expect(r.value).toBe('undefined');
  });

  it('cannot reach host objects via constructor tricks', async () => {
    const r = await runInSandbox(
      'try { return this.constructor.constructor("return process")().version; } catch (e) { return "blocked"; }',
      base,
    );
    expect(r.value === 'blocked' || r.value === undefined).toBe(true);
  });

  it('cannot tamper with foundry', async () => {
    const r = await runInSandbox(
      '"use strict"; try { foundry.list = null; } catch(e) {} return typeof foundry.list;',
      base,
    );
    expect(r.value).toBe('function');
  });

  it('stops an infinite loop', async () => {
    const r = await runInSandbox('while (true) {}', { ...base, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('time limit') });
  });

  it('stops a never-resolving promise', async () => {
    const r = await runInSandbox('await new Promise(() => {});', { ...base, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('time limit') });
  });

  it('enforces the memory limit', async () => {
    const r = await runInSandbox('const a = []; while (true) a.push(new Array(10000).fill(1));', {
      ...base,
      memoryBytes: 4 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
  });

  it('reports syntax and runtime errors', async () => {
    expect((await runInSandbox('return (;', base)).ok).toBe(false);
    expect((await runInSandbox('throw new Error("boom")', base)).error).toContain('boom');
  });

  it('truncates oversized output', async () => {
    const r = await runInSandbox('return "x".repeat(10000);', base);
    expect(String(r.value).length).toBeLessThan(2100);
  });
});
