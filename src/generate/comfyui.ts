/**
 * @fileoverview Minimal ComfyUI HTTP client and the D&D battlemap SDXL workflow
 *
 * Adapted from the foundry-vtt-mcp bridge by adambdooley (MIT licence): the
 * `/prompt`, `/history`, `/queue` and `/view` calls and the SDXL battlemap
 * workflow. The bridge's install/start/stop service management is dropped on
 * purpose: ComfyUI runs on another machine (for example a Windows desktop with
 * a GPU) and this server only talks to it over HTTP.
 */

import axios from 'axios';

export interface MapWorkflowInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  quality?: 'low' | 'medium' | 'high';
  /** Guidance scale (the model works best at 2 to 3). */
  cfg?: number;
  /** Extra negative-prompt terms, appended to the built-in list. */
  avoid?: string;
}

export interface ComfyUIOptions {
  baseUrl: string;
  checkpoint: string;
  vae: string;
  /** Optional key for a hosted or proxied ComfyUI. Never logged. */
  apiKey?: string | undefined;
  /**
   * Header that carries the key. Unset or `Authorization` sends `Bearer <key>`;
   * any other name (e.g. a proxy header) receives the raw key.
   */
  authHeader?: string | undefined;
  /** Replaceable in tests. When injected, the caller owns request headers. */
  http?: HttpLike;
}

/** The subset of axios used here. */
export interface HttpLike {
  get<T = unknown>(
    url: string,
    config?: Record<string, unknown>,
  ): Promise<{ data: T; status?: number }>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    config?: Record<string, unknown>,
  ): Promise<{ data: T; status?: number }>;
}

export interface ComfyUIImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export type ComfyUIJobState = 'queued' | 'running' | 'complete' | 'failed' | 'unknown';

export interface ComfyUIHealth {
  available: boolean;
  responseTimeMs?: number;
  gpu?: string;
  error?: string;
}

export const SIZE_PIXELS = { small: 1024, medium: 1536, large: 2048 } as const;
export type MapSize = keyof typeof SIZE_PIXELS;

const STEPS = { low: 8, medium: 20, high: 35 } as const;

/** SDXL is trained at about 1024px; larger direct renders repeat or fragment the layout. */
const NATIVE_SIDE = 1024;
const DEFAULT_CFG = 2.5;
const REFINE_DENOISE = 0.5;
const BASE_NEGATIVE =
  'grid, low angle, isometric, oblique, horizon, text, watermark, logo, caption, people, creatures, monsters, blurry, artifacts';

function round64(value: number): number {
  return Math.max(512, Math.round(value / 64) * 64);
}

/** Pass-1 size: the target scaled down so its longest side is 1024 (sides stay multiples of 64). */
export function nativeSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= NATIVE_SIDE) {
    return { width, height };
  }
  const scale = NATIVE_SIDE / longest;
  return { width: round64(width * scale), height: round64(height * scale) };
}

/**
 * The bridge's battlemap workflow: positive prompt carries the model's trigger
 * words, negative prompt keeps out grids, people and perspective.
 *
 * Targets above 1024px render in two passes, as the model author recommends:
 * a native-size base, then a latent upscale and a half-strength refine, decoded
 * in tiles to stay inside 12 GB of VRAM.
 */
export function buildWorkflow(
  input: MapWorkflowInput,
  models: { checkpoint: string; vae: string },
): Record<string, unknown> {
  const positive = `2d DnD battlemap of ${input.prompt}, top-down view, overhead perspective, aerial`;
  const negative = input.avoid ? `${BASE_NEGATIVE}, ${input.avoid}` : BASE_NEGATIVE;
  const steps = STEPS[input.quality ?? 'medium'];
  const cfg = input.cfg ?? DEFAULT_CFG;
  const seed = input.seed ?? Math.floor(Math.random() * 1_000_000);
  const base = nativeSize(input.width, input.height);
  const twoPass = base.width !== input.width || base.height !== input.height;
  const sampler = {
    seed,
    cfg,
    sampler_name: 'dpmpp_2m_sde',
    scheduler: 'karras',
    model: ['1', 0],
    positive: ['2', 0],
    negative: ['3', 0],
  };
  const workflow: Record<string, unknown> = {
    '1': { inputs: { ckpt_name: models.checkpoint }, class_type: 'CheckpointLoaderSimple' },
    '2': { inputs: { text: positive, clip: ['1', 1] }, class_type: 'CLIPTextEncode' },
    '3': { inputs: { text: negative, clip: ['1', 1] }, class_type: 'CLIPTextEncode' },
    '4': {
      inputs: { width: base.width, height: base.height, batch_size: 1 },
      class_type: 'EmptyLatentImage',
    },
    '5': {
      inputs: { ...sampler, steps, denoise: 1.0, latent_image: ['4', 0] },
      class_type: 'KSampler',
    },
    '9': { inputs: { vae_name: models.vae }, class_type: 'VAELoader' },
    '7': { inputs: { filename_prefix: 'battlemap', images: ['6', 0] }, class_type: 'SaveImage' },
  };
  if (!twoPass) {
    workflow['6'] = { inputs: { samples: ['5', 0], vae: ['9', 0] }, class_type: 'VAEDecode' };
    return workflow;
  }
  workflow['10'] = {
    inputs: {
      samples: ['5', 0],
      upscale_method: 'bislerp',
      width: input.width,
      height: input.height,
      crop: 'disabled',
    },
    class_type: 'LatentUpscale',
  };
  workflow['11'] = {
    inputs: {
      ...sampler,
      steps: Math.max(6, Math.round(steps / 2)),
      denoise: REFINE_DENOISE,
      latent_image: ['10', 0],
    },
    class_type: 'KSampler',
  };
  workflow['6'] = {
    inputs: { samples: ['11', 0], vae: ['9', 0], tile_size: 512, overlap: 64 },
    class_type: 'VAEDecodeTiled',
  };
  return workflow;
}

function describeError(error: unknown, secret?: string): string {
  const redact = (text: string) => (secret ? text.split(secret).join('[redacted]') : text);
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      return `cannot reach ComfyUI (${error.code})`;
    }
    const detail = error.response?.data;
    const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '';
    return redact(`${error.message}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  return redact(error instanceof Error ? error.message : String(error));
}

/** Builds the auth header for a hosted ComfyUI, or nothing when no key is set. */
export function buildAuthHeaders(apiKey?: string, authHeader?: string): Record<string, string> {
  if (!apiKey) {
    return {};
  }
  const name = authHeader?.trim() || 'Authorization';
  const value = name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
  return { [name]: value };
}

export class ComfyUIClient {
  readonly baseUrl: string;
  private readonly http: HttpLike;
  private readonly clientId = `foundryvtt-mcp-${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly options: ComfyUIOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.http =
      options.http ??
      (axios.create({
        baseURL: this.baseUrl,
        headers: buildAuthHeaders(options.apiKey, options.authHeader),
      }) as unknown as HttpLike);
  }

  async checkHealth(): Promise<ComfyUIHealth> {
    const started = Date.now();
    try {
      const { data } = await this.http.get<{ devices?: Array<{ name?: string }> }>(
        '/system_stats',
        {
          timeout: 5000,
        },
      );
      const gpu = data?.devices?.[0]?.name;
      return {
        available: true,
        responseTimeMs: Date.now() - started,
        ...(gpu ? { gpu } : {}),
      };
    } catch (error) {
      return { available: false, error: describeError(error, this.options.apiKey) };
    }
  }

  /** Queues a map render and returns ComfyUI's prompt id. */
  async submit(input: MapWorkflowInput): Promise<string> {
    const workflow = buildWorkflow(input, this.options);
    try {
      const { data } = await this.http.post<{
        prompt_id?: string;
        node_errors?: Record<string, unknown>;
      }>('/prompt', { prompt: workflow, client_id: this.clientId }, { timeout: 10000 });
      if (!data?.prompt_id) {
        throw new Error('ComfyUI did not return a prompt id');
      }
      return data.prompt_id;
    } catch (error) {
      const message = describeError(error, this.options.apiKey);
      if (/ckpt_name|vae_name|not in \[/.test(message)) {
        throw new Error(
          `ComfyUI does not have the model this workflow needs (${this.options.checkpoint} / ${this.options.vae}). Install them, or set COMFYUI_CHECKPOINT / COMFYUI_VAE to names that exist. Details: ${message}`,
        );
      }
      throw new Error(`ComfyUI rejected the job: ${message}`);
    }
  }

  async getStatus(
    promptId: string,
  ): Promise<{ state: ComfyUIJobState; queuePosition?: number; error?: string }> {
    const { data: history } = await this.http.get<
      Record<string, { status?: { status_str?: string; messages?: unknown[] } }>
    >(`/history/${promptId}`, { timeout: 5000 });
    const entry = history?.[promptId];
    if (entry) {
      if (entry.status?.status_str === 'error') {
        const failure = (entry.status.messages ?? []).find(
          (m) => Array.isArray(m) && m[0] === 'execution_error',
        ) as [string, { exception_message?: string }] | undefined;
        return {
          state: 'failed',
          error: failure?.[1]?.exception_message ?? 'ComfyUI reported an error while rendering',
        };
      }
      return { state: 'complete' };
    }
    const { data: queue } = await this.http.get<{
      queue_running?: unknown[][];
      queue_pending?: unknown[][];
    }>('/queue', { timeout: 5000 });
    if ((queue?.queue_running ?? []).some((q) => q[1] === promptId)) {
      return { state: 'running' };
    }
    const pending = (queue?.queue_pending ?? []).findIndex((q) => q[1] === promptId);
    if (pending >= 0) {
      return { state: 'queued', queuePosition: pending + 1 };
    }
    return { state: 'unknown' };
  }

  async getImages(promptId: string): Promise<ComfyUIImageRef[]> {
    const { data } = await this.http.get<
      Record<string, { outputs?: Record<string, { images?: Array<Partial<ComfyUIImageRef>> }> }>
    >(`/history/${promptId}`, { timeout: 5000 });
    const outputs = data?.[promptId]?.outputs ?? {};
    const images: ComfyUIImageRef[] = [];
    for (const node of Object.values(outputs)) {
      for (const image of node.images ?? []) {
        if (image.filename) {
          images.push({
            filename: image.filename,
            subfolder: image.subfolder ?? '',
            type: image.type ?? 'output',
          });
        }
      }
    }
    return images;
  }

  async download(image: ComfyUIImageRef): Promise<Buffer> {
    const { data } = await this.http.get<ArrayBuffer>('/view', {
      params: { filename: image.filename, subfolder: image.subfolder, type: image.type },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(data);
  }

  /** Removes a queued job, or interrupts it if it is rendering. */
  async cancel(promptId: string): Promise<boolean> {
    const status = await this.getStatus(promptId);
    if (status.state === 'queued') {
      await this.http.post('/queue', { delete: [promptId] }, { timeout: 5000 });
      return true;
    }
    if (status.state === 'running') {
      await this.http.post('/interrupt', {}, { timeout: 5000 });
      return true;
    }
    return false;
  }
}
