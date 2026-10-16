/**
 * @fileoverview Background map generation: render in ComfyUI, then import into Foundry
 *
 * A job is submitted to ComfyUI and then watched in the background. When the
 * render finishes the image is downloaded, uploaded to Foundry's data folder and
 * an INACTIVE scene is created with it as the background. Jobs live in memory:
 * a server restart forgets running jobs (the render itself continues in ComfyUI).
 */

import type { FoundryClient } from '../foundry/client.js';
import { slugify } from '../foundry/files.js';
import { logger } from '../utils/logger.js';
import type { ComfyUIClient, MapSize, MapWorkflowInput } from './comfyui.js';
import { SIZE_PIXELS } from './comfyui.js';

export type MapJobStatus = 'queued' | 'generating' | 'importing' | 'done' | 'failed' | 'cancelled';

export interface MapJobParams {
  prompt: string;
  sceneName: string;
  size?: MapSize;
  width?: number;
  height?: number;
  gridSize?: number;
  quality?: 'low' | 'medium' | 'high';
  seed?: number;
  /** Id of an existing Scene folder for the new scene. */
  folderId?: string;
}

export interface MapJob {
  id: string;
  promptId: string;
  status: MapJobStatus;
  sceneName: string;
  prompt: string;
  width: number;
  height: number;
  gridSize: number;
  createdAt: number;
  updatedAt: number;
  queuePosition?: number;
  error?: string;
  imagePath?: string;
  sceneId?: string;
  folderId?: string;
}

export interface MapJobDeps {
  comfy: ComfyUIClient;
  foundry: FoundryClient;
  /** Where uploads go, e.g. worlds/<world>/mcp-uploads. */
  uploadDir: () => string;
  pollMs?: number;
  /** Give up on a render after this long. */
  timeoutMs?: number;
}

const MIN_GRID = 50;

/** Width and height from a PNG header, or null for anything else. */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function clampSide(value: number): number {
  return Math.min(2048, Math.max(512, Math.round(value / 64) * 64));
}

export class MapJobManager {
  private readonly jobs = new Map<string, MapJob>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly unknownCount = new Map<string, number>();
  private counter = 0;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: MapJobDeps) {
    this.pollMs = deps.pollMs ?? 5000;
    this.timeoutMs = deps.timeoutMs ?? 30 * 60 * 1000;
  }

  async start(params: MapJobParams): Promise<MapJob> {
    const side = SIZE_PIXELS[params.size ?? 'medium'];
    const width = clampSide(params.width ?? side);
    const height = clampSide(params.height ?? side);
    const input: MapWorkflowInput = {
      prompt: params.prompt,
      width,
      height,
      ...(params.quality ? { quality: params.quality } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
    };
    const promptId = await this.deps.comfy.submit(input);
    this.counter += 1;
    const now = Date.now();
    const job: MapJob = {
      id: `map-${now.toString(36)}-${this.counter}`,
      promptId,
      status: 'queued',
      sceneName: params.sceneName,
      prompt: params.prompt,
      width,
      height,
      gridSize: Math.max(MIN_GRID, Math.round(params.gridSize ?? 70)),
      createdAt: now,
      updatedAt: now,
      ...(params.folderId ? { folderId: params.folderId } : {}),
    };
    this.jobs.set(job.id, job);
    this.schedule(job);
    return job;
  }

  get(id: string): MapJob | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(): MapJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async cancel(id: string): Promise<MapJob> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`No map job ${id}`);
    }
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Map job ${id} already finished (${job.status})`);
    }
    if (job.status === 'importing') {
      throw new Error(`Map job ${id} is already being imported; delete the scene instead`);
    }
    await this.deps.comfy.cancel(job.promptId);
    this.finish(job, 'cancelled');
    return job;
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(job: MapJob): void {
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      void this.advance(job).then(() => {
        if (job.status === 'queued' || job.status === 'generating') {
          this.schedule(job);
        }
      });
    }, this.pollMs);
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private finish(job: MapJob, status: MapJobStatus, error?: string): void {
    job.status = status;
    job.updatedAt = Date.now();
    if (error) {
      job.error = error;
    }
    const timer = this.timers.get(job.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(job.id);
    }
  }

  /** One polling step. Exposed for tests; the background timer calls it. */
  async advance(job: MapJob): Promise<void> {
    if (job.status !== 'queued' && job.status !== 'generating') {
      return;
    }
    if (Date.now() - job.createdAt > this.timeoutMs) {
      this.finish(job, 'failed', `Gave up after ${Math.round(this.timeoutMs / 60000)} minutes`);
      return;
    }
    try {
      const status = await this.deps.comfy.getStatus(job.promptId);
      job.updatedAt = Date.now();
      switch (status.state) {
        case 'queued':
          job.status = 'queued';
          if (status.queuePosition !== undefined) {
            job.queuePosition = status.queuePosition;
          }
          this.unknownCount.delete(job.id);
          return;
        case 'running':
          job.status = 'generating';
          delete job.queuePosition;
          this.unknownCount.delete(job.id);
          return;
        case 'failed':
          this.finish(job, 'failed', status.error ?? 'ComfyUI failed to render the map');
          return;
        case 'unknown': {
          const misses = (this.unknownCount.get(job.id) ?? 0) + 1;
          this.unknownCount.set(job.id, misses);
          if (misses >= 3) {
            this.finish(
              job,
              'failed',
              'ComfyUI no longer knows this job (was it restarted or the queue cleared?)',
            );
          }
          return;
        }
        case 'complete':
          await this.importResult(job);
          return;
      }
    } catch (error) {
      // A transient network error should not kill a long render; the timeout bounds it.
      logger.warn('Map job poll failed', {
        job: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async importResult(job: MapJob): Promise<void> {
    job.status = 'importing';
    try {
      const images = await this.deps.comfy.getImages(job.promptId);
      const image = images[0];
      if (!image) {
        this.finish(job, 'failed', 'ComfyUI finished but returned no image');
        return;
      }
      const buffer = await this.deps.comfy.download(image);
      const real = pngSize(buffer);
      const width = real?.width ?? job.width;
      const height = real?.height ?? job.height;
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      job.imagePath = await this.deps.foundry.uploadFile(
        buffer,
        `${slugify(job.sceneName)}-${stamp}.png`,
        this.deps.uploadDir(),
      );
      const [scene] = await this.deps.foundry.createDocuments('Scene', [
        {
          name: job.sceneName,
          active: false,
          navigation: false,
          background: { src: job.imagePath },
          width,
          height,
          padding: 0,
          grid: { size: job.gridSize, distance: 5, units: 'ft' },
          ...(job.folderId ? { folder: job.folderId } : {}),
        },
      ]);
      if (scene?._id) {
        job.sceneId = String(scene._id);
      }
      this.finish(job, 'done');
    } catch (error) {
      this.finish(
        job,
        'failed',
        `Rendered, but importing into Foundry failed: ${error instanceof Error ? error.message : String(error)}${job.imagePath ? ` (the image is at ${job.imagePath})` : ''}`,
      );
    }
  }
}
