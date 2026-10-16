import { describe, expect, it, vi } from 'vitest';
import { buildWorkflow, ComfyUIClient, type HttpLike } from '../comfyui.js';

const MODELS = { checkpoint: 'battle.safetensors', vae: 'vae.safetensors' };

function client(handlers: {
  get?: (url: string, config?: Record<string, unknown>) => unknown;
  post?: (url: string, body?: unknown) => unknown;
}) {
  const http: HttpLike = {
    get: vi.fn(async (url: string, config?: Record<string, unknown>) => {
      const data = handlers.get?.(url, config);
      if (data instanceof Error) {
        throw data;
      }
      return { data };
    }) as HttpLike['get'],
    post: vi.fn(async (url: string, body?: unknown) => {
      const data = handlers.post?.(url, body);
      if (data instanceof Error) {
        throw data;
      }
      return { data };
    }) as HttpLike['post'],
  };
  return { comfy: new ComfyUIClient({ baseUrl: 'http://gpu:8188/', ...MODELS, http }), http };
}

describe('buildWorkflow', () => {
  it('wraps the prompt with the model trigger words and uses the configured models', () => {
    const wf = buildWorkflow(
      { prompt: 'a tavern', width: 1024, height: 1536, seed: 7, quality: 'high' },
      MODELS,
    ) as Record<string, { inputs: Record<string, unknown> }>;
    expect(wf['1']?.inputs.ckpt_name).toBe('battle.safetensors');
    expect(wf['9']?.inputs.vae_name).toBe('vae.safetensors');
    expect(wf['2']?.inputs.text).toBe(
      '2d DnD battlemap of a tavern, top-down view, overhead perspective, aerial',
    );
    expect(String(wf['3']?.inputs.text)).toContain('grid');
    expect(wf['4']?.inputs).toMatchObject({ width: 1024, height: 1536 });
    expect(wf['5']?.inputs).toMatchObject({ seed: 7, steps: 35 });
  });

  it('maps quality to steps, low by default', () => {
    const steps = (q?: 'low' | 'medium' | 'high') =>
      (
        buildWorkflow(
          { prompt: 'x', width: 512, height: 512, ...(q ? { quality: q } : {}) },
          MODELS,
        ) as Record<string, { inputs: { steps?: number } }>
      )['5']?.inputs.steps;
    expect([steps(), steps('medium'), steps('high')]).toEqual([8, 20, 35]);
  });
});

describe('ComfyUIClient', () => {
  it('submits the workflow and returns the prompt id', async () => {
    const { comfy, http } = client({ post: () => ({ prompt_id: 'abc' }) });
    expect(comfy.baseUrl).toBe('http://gpu:8188');
    expect(await comfy.submit({ prompt: 'cave', width: 1024, height: 1024 })).toBe('abc');
    const [url, body] = vi.mocked(http.post).mock.calls[0] as [
      string,
      { prompt: unknown; client_id: string },
    ];
    expect(url).toBe('/prompt');
    expect(body.client_id).toMatch(/^foundryvtt-mcp-/);
    expect(body.prompt).toHaveProperty('7.class_type', 'SaveImage');
  });

  it('explains a missing model and a refused job', async () => {
    const missing = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: {
        data: {
          error: { message: "Value not in list: ckpt_name: 'battle.safetensors' not in []" },
        },
      },
    });
    const { comfy } = client({ post: () => missing });
    await expect(comfy.submit({ prompt: 'x', width: 512, height: 512 })).rejects.toThrow(
      /does not have the model.*COMFYUI_CHECKPOINT/,
    );
    const { comfy: none } = client({ post: () => ({}) });
    await expect(none.submit({ prompt: 'x', width: 512, height: 512 })).rejects.toThrow(
      /prompt id/,
    );
  });

  it('reads job state from history, then the queue', async () => {
    const queue = {
      queue_running: [[0, 'run1']],
      queue_pending: [
        [1, 'p0'],
        [2, 'wait'],
      ],
    };
    const history: Record<string, unknown> = {
      done: { status: { status_str: 'success' } },
      bad: {
        status: {
          status_str: 'error',
          messages: [['execution_error', { exception_message: 'CUDA out of memory' }]],
        },
      },
    };
    const { comfy } = client({
      get: (url) => {
        if (url === '/queue') {
          return queue;
        }
        const id = url.replace('/history/', '');
        return id in history ? { [id]: history[id] } : {};
      },
    });
    expect(await comfy.getStatus('done')).toEqual({ state: 'complete' });
    expect(await comfy.getStatus('bad')).toEqual({ state: 'failed', error: 'CUDA out of memory' });
    expect(await comfy.getStatus('run1')).toEqual({ state: 'running' });
    expect(await comfy.getStatus('wait')).toEqual({ state: 'queued', queuePosition: 2 });
    expect(await comfy.getStatus('ghost')).toEqual({ state: 'unknown' });
  });

  it('lists output images and downloads one with its subfolder and type', async () => {
    const { comfy, http } = client({
      get: (url) =>
        url.startsWith('/history/')
          ? {
              j: {
                outputs: {
                  '7': { images: [{ filename: 'battlemap_1.png', subfolder: '', type: 'output' }] },
                },
              },
            }
          : new Uint8Array([1, 2, 3]).buffer,
    });
    const images = await comfy.getImages('j');
    expect(images).toEqual([{ filename: 'battlemap_1.png', subfolder: '', type: 'output' }]);
    const bytes = await comfy.download(images[0] as never);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(vi.mocked(http.get).mock.calls.at(-1)?.[1]).toMatchObject({
      params: { filename: 'battlemap_1.png', subfolder: '', type: 'output' },
    });
  });

  it('cancels a queued job by deleting it and a running job by interrupting', async () => {
    const queue = { queue_running: [[0, 'run']], queue_pending: [[1, 'wait']] };
    const { comfy, http } = client({ get: (url) => (url === '/queue' ? queue : {}) });
    expect(await comfy.cancel('wait')).toBe(true);
    expect(http.post).toHaveBeenLastCalledWith('/queue', { delete: ['wait'] }, expect.anything());
    expect(await comfy.cancel('run')).toBe(true);
    expect(vi.mocked(http.post).mock.calls.at(-1)?.[0]).toBe('/interrupt');
    expect(await comfy.cancel('gone')).toBe(false);
  });

  it('reports health with the GPU name, or why it is unreachable', async () => {
    const up = client({ get: () => ({ devices: [{ name: 'RTX 4070' }] }) });
    expect(await up.comfy.checkHealth()).toMatchObject({ available: true, gpu: 'RTX 4070' });
    const down = client({
      get: () => Object.assign(new Error('connect'), { isAxiosError: true, code: 'ECONNREFUSED' }),
    });
    const health = await down.comfy.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).toContain('cannot reach ComfyUI');
  });
});
