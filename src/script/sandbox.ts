/**
 * @fileoverview QuickJS sandbox: runs untrusted script text with no ambient
 * capabilities. The only host access is `__call` (JSON in, JSON out) and
 * `__log`; time, memory and stack are capped.
 */

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';

export interface SandboxOptions {
  timeoutMs: number;
  memoryBytes: number;
  maxOutputChars: number;
  call: (method: string, args: unknown[]) => Promise<unknown>;
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  truncated: boolean;
}

const PRELUDE = `
const __wrap = (m) => async (...a) => {
  const r = JSON.parse(await __call(m, JSON.stringify(a)));
  if (r.error) throw new Error(r.error);
  return r.value;
};
globalThis.foundry = Object.freeze({
  list: __wrap('list'), get: __wrap('get'), create: __wrap('create'),
  update: __wrap('update'), delete: __wrap('delete'), chat: __wrap('chat'),
});
globalThis.console = Object.freeze({
  log: (...a) => __log(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
});
`;

export async function runInSandbox(code: string, opts: SandboxOptions): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + opts.timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm: QuickJSContext = runtime.newContext();

  const logs: string[] = [];
  let logChars = 0;
  let truncated = false;
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;

  const callFn = vm.newFunction('__call', (methodH, argsH) => {
    const method = vm.getString(methodH);
    const args = JSON.parse(vm.getString(argsH)) as unknown[];
    const deferred = vm.newPromise();
    opts
      .call(method, args)
      .then(
        (value) => JSON.stringify({ value: value ?? null }),
        (e: unknown) => JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      )
      .then((json) => {
        if (disposed) {
          return;
        }
        const h = vm.newString(json);
        deferred.resolve(h);
        h.dispose();
        runtime.executePendingJobs();
      });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__call', callFn);
  callFn.dispose();

  const logFn = vm.newFunction('__log', (lineH) => {
    const line = vm.getString(lineH);
    if (logChars + line.length > opts.maxOutputChars) {
      truncated = true;
    } else {
      logChars += line.length;
      logs.push(line);
    }
  });
  vm.setProp(vm.global, '__log', logFn);
  logFn.dispose();

  const finish = (r: Omit<SandboxResult, 'logs' | 'truncated'>): SandboxResult => ({
    ...r,
    logs,
    truncated,
  });

  try {
    vm.unwrapResult(vm.evalCode(PRELUDE, 'prelude.js')).dispose();
    const evaluated = vm.evalCode(`(async () => {\n${code}\n})()`, 'script.js');
    if (evaluated.error) {
      const err = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return finish({ ok: false, error: describe(err, deadline, opts.timeoutMs) });
    }
    const promiseHandle: QuickJSHandle = evaluated.value;
    const settled = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    runtime.executePendingJobs();

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    });
    const outcome = await Promise.race([settled, timeout]);
    if (outcome === 'timeout') {
      return finish({
        ok: false,
        error: `Script exceeded the ${opts.timeoutMs / 1000}s time limit`,
      });
    }
    if (outcome.error) {
      const err = vm.dump(outcome.error);
      outcome.error.dispose();
      return finish({ ok: false, error: describe(err, deadline, opts.timeoutMs) });
    }
    const dumped = vm.dump(outcome.value);
    outcome.value.dispose();
    const json = JSON.stringify(dumped ?? null);
    if (json.length > opts.maxOutputChars) {
      return finish({
        ok: true,
        value: `${json.slice(0, opts.maxOutputChars)}…`,
      });
    }
    return finish({ ok: true, value: dumped });
  } catch (e) {
    return finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
    disposed = true;
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // Disposal can throw if the script left pending promises; the runtime is discarded anyway.
    }
  }
}

function describe(err: unknown, deadline: number, timeoutMs: number): string {
  if (
    Date.now() >= deadline &&
    String((err as { message?: string })?.message).includes('interrupted')
  ) {
    return `Script exceeded the ${timeoutMs / 1000}s time limit`;
  }
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    return `${e.name ?? 'Error'}: ${e.message ?? JSON.stringify(err)}`;
  }
  return String(err);
}
