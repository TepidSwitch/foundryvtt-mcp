import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthHeaders,
  buildWorkflow,
  ComfyUIClient,
  type ComfyUIOptions,
  type HttpLike,
} from '../comfyui.js';

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
    expect(wf['4']?.inputs).toMatchObject({ width: 704, height: 1024 });
    expect(wf['10']?.inputs).toMatchObject({ width: 1024, height: 1536 });
    expect(wf['5']?.inputs).toMatchObject({ seed: 7, steps: 35 });
  });

  it('maps quality to steps, medium by default', () => {
    const steps = (q?: 'low' | 'medium' | 'high') =>
      (
        buildWorkflow(
          { prompt: 'x', width: 512, height: 512, ...(q ? { quality: q } : {}) },
          MODELS,
        ) as Record<string, { inputs: { steps?: number } }>
      )['5']?.inputs.steps;
    expect([steps('low'), steps(), steps('high')]).toEqual([8, 20, 35]);
  });
});

describe('buildWorkflow two-pass', () => {
  type Wf = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const build = (w: number, h: number, extra = {}) =>
    buildWorkflow({ prompt: 'x', width: w, height: h, seed: 3, ...extra }, MODELS) as Wf;

  it('keeps a single pass at 1024px or less', () => {
    const wf = build(1024, 1024);
    expect(wf['6']?.class_type).toBe('VAEDecode');
    expect(wf['10']).toBeUndefined();
  });

  it('renders at native size, upscales the latent, refines at half strength, decodes in tiles', () => {
    const wf = build(1536, 1536, { quality: 'medium' });
    expect(wf['4']?.inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(wf['10']).toMatchObject({
      class_type: 'LatentUpscale',
      inputs: { samples: ['5', 0], width: 1536, height: 1536, crop: 'disabled' },
    });
    expect(wf['11']?.inputs).toMatchObject({ denoise: 0.5, steps: 10, latent_image: ['10', 0] });
    expect(wf['6']).toMatchObject({
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['11', 0], tile_size: 512 },
    });
  });

  it('keeps the aspect ratio and 64px sides in the base pass', () => {
    const wf = build(2048, 1024);
    expect(wf['4']?.inputs).toMatchObject({ width: 1024, height: 512 });
  });

  it('applies cfg to both passes and appends avoid to the negative prompt', () => {
    const wf = build(1536, 1536, { cfg: 2, avoid: 'trees, fog' });
    expect(wf['5']?.inputs.cfg).toBe(2);
    expect(wf['11']?.inputs.cfg).toBe(2);
    expect(String(wf['3']?.inputs.text)).toMatch(/artifacts, trees, fog$/);
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

describe('ComfyUI auth header', () => {
  const KEY = 'secret-key-123';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Builds a real client whose axios instance is answered by a fake adapter, so the
   * headers axios actually sends are what the test sees.
   */
  function hostedClient(options: Partial<ComfyUIOptions>) {
    const sent: Array<{ method?: string; url?: string; headers: Record<string, unknown> }> = [];
    const queue: { queue_running?: unknown[][]; queue_pending?: unknown[][] } = {
      queue_pending: [[1, 'p1']],
    };
    const realCreate = axios.create.bind(axios);
    vi.spyOn(axios, 'create').mockImplementation((cfg) =>
      realCreate({
        ...cfg,
        adapter: async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
          sent.push({
            method: config.method,
            url: config.url,
            headers: { ...(config.headers.toJSON() as Record<string, unknown>) },
          });
          let data: unknown = {};
          if (config.url === '/prompt') {
            data = { prompt_id: 'p1' };
          } else if (config.url === '/queue' && config.method === 'get') {
            data = queue;
          } else if (config.url?.startsWith('/view')) {
            data = new ArrayBuffer(2);
          }
          return { data, status: 200, statusText: 'OK', headers: {}, config };
        },
      }),
    );
    const comfy = new ComfyUIClient({
      baseUrl: 'http://gpu:8188',
      ...MODELS,
      ...options,
    });
    return { comfy, sent, queue };
  }

  it('builds Bearer for the default header and the raw key for a custom one', () => {
    expect(buildAuthHeaders(KEY)).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(buildAuthHeaders(KEY, 'Authorization')).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(buildAuthHeaders(KEY, 'X-Proxy-Key')).toEqual({ 'X-Proxy-Key': KEY });
    expect(buildAuthHeaders(undefined, 'X-Proxy-Key')).toEqual({});
    expect(buildAuthHeaders('')).toEqual({});
  });

  it('sends Authorization: Bearer on every request type', async () => {
    const { comfy, sent, queue } = hostedClient({ apiKey: KEY });
    await comfy.checkHealth();
    await comfy.submit({ prompt: 'cave', width: 512, height: 512 });
    await comfy.getStatus('p1');
    await comfy.download({ filename: 'a.png', subfolder: '', type: 'output' });
    await comfy.cancel('p1'); // queued -> DELETE /queue
    queue.queue_pending = [];
    queue.queue_running = [[0, 'p1']];
    await comfy.cancel('p1'); // running -> POST /interrupt

    const urls = sent.map((r) => `${r.method} ${r.url}`);
    expect(urls).toEqual(
      expect.arrayContaining([
        'get /system_stats',
        'post /prompt',
        'get /history/p1',
        'get /queue',
        'get /view',
        'post /queue',
        'post /interrupt',
      ]),
    );
    for (const request of sent) {
      expect(request.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('sends the raw key under a custom header name and no Authorization header', async () => {
    const { comfy, sent } = hostedClient({ apiKey: KEY, authHeader: 'X-Proxy-Key' });
    await comfy.checkHealth();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.headers['X-Proxy-Key']).toBe(KEY);
      expect(request.headers.Authorization).toBeUndefined();
    }
  });

  it('sends no auth header when no key is configured', async () => {
    const { comfy, sent } = hostedClient({});
    await comfy.checkHealth();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.headers.Authorization).toBeUndefined();
      expect(request.headers['X-Proxy-Key']).toBeUndefined();
    }
  });

  it('never puts the key in error messages', async () => {
    vi.spyOn(axios, 'create').mockImplementation(
      () =>
        ({
          get: vi.fn(async () => {
            throw new Error(`upstream rejected ${KEY}`);
          }),
          post: vi.fn(async () => {
            throw new Error(`upstream rejected ${KEY}`);
          }),
        }) as never,
    );
    const comfy = new ComfyUIClient({ baseUrl: 'http://gpu:8188', ...MODELS, apiKey: KEY });
    const health = await comfy.checkHealth();
    expect(health.available).toBe(false);
    expect(health.error).not.toContain(KEY);
    expect(health.error).toContain('[redacted]');
    const submitError = await comfy
      .submit({ prompt: 'x', width: 512, height: 512 })
      .catch((error: unknown) => error);
    expect(String(submitError)).not.toContain(KEY);
    expect(String(submitError)).toContain('[redacted]');
  });
});
