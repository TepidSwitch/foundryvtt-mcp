import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import type { ComfyUIClient } from '../comfyui.js';
import { MapJobManager, pngSize } from '../map-jobs.js';

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function setup(states: Array<{ state: string; queuePosition?: number; error?: string }>) {
  const queue = [...states];
  const comfy = {
    submit: vi.fn(async () => 'prompt-1'),
    getStatus: vi.fn(async () => queue.shift() ?? { state: 'complete' }),
    getImages: vi.fn(async () => [{ filename: 'b.png', subfolder: '', type: 'output' }]),
    download: vi.fn(async () => png(1536, 1024)),
    cancel: vi.fn(async () => true),
  } as unknown as ComfyUIClient;
  const foundry = {
    uploadFile: vi.fn(async (_b: Buffer, name: string, dir: string) => `${dir}/${name}`),
    createDocuments: vi.fn(async () => [{ _id: 'SCENEAAAAAAAAAAA' }]),
  } as unknown as FoundryClient;
  const manager = new MapJobManager({
    comfy,
    foundry,
    uploadDir: () => 'worlds/w/mcp-uploads',
    pollMs: 1_000_000,
  });
  return { manager, comfy, foundry };
}

afterEach(() => vi.useRealTimers());

describe('pngSize', () => {
  it('reads the header and ignores other data', () => {
    expect(pngSize(png(1536, 1024))).toEqual({ width: 1536, height: 1024 });
    expect(pngSize(Buffer.from('not a png at all, definitely not'))).toBeNull();
  });
});

describe('MapJobManager', () => {
  it('rounds the image size to 64 and keeps the grid at 50px or more', async () => {
    const { manager, comfy } = setup([]);
    const job = await manager.start({
      prompt: 'p',
      sceneName: 'S',
      width: 1000,
      height: 100000,
      gridSize: 10,
      seed: 7,
    });
    expect(job).toMatchObject({ width: 1024, height: 2048, gridSize: 50, status: 'queued' });
    expect(comfy.submit).toHaveBeenCalledWith({
      prompt: 'p',
      quality: 'low',
      seed: 7,
      width: 1024,
      height: 2048,
    });
    manager.dispose();
  });

  it('follows the render, then uploads the image and creates an inactive scene', async () => {
    const { manager, foundry } = setup([
      { state: 'queued', queuePosition: 2 },
      { state: 'running' },
      { state: 'complete' },
    ]);
    const job = await manager.start({
      prompt: 'p',
      sceneName: 'Moonlit Tavern',
      gridSize: 70,
      seed: 42,
      quality: 'medium',
      folderId: 'FOLDERAAAAAAAAAA',
    });
    await manager.advance(job);
    expect(job).toMatchObject({ status: 'queued', queuePosition: 2 });
    await manager.advance(job);
    expect(job.status).toBe('generating');
    await manager.advance(job);
    expect(job.status).toBe('done');
    expect(job.sceneId).toBe('SCENEAAAAAAAAAAA');
    const [, name, dir] = vi.mocked(foundry.uploadFile).mock.calls[0] as unknown as [
      Buffer,
      string,
      string,
    ];
    expect(name).toMatch(/^moonlit-tavern-\d{14}\.png$/);
    expect(dir).toBe('worlds/w/mcp-uploads');
    expect(foundry.createDocuments).toHaveBeenCalledWith('Scene', [
      {
        name: 'Moonlit Tavern',
        active: false,
        navigation: false,
        background: { src: job.imagePath },
        width: 1536,
        height: 1024,
        padding: 0,
        grid: { size: 70, distance: 5, units: 'ft' },
        folder: 'FOLDERAAAAAAAAAA',
        flags: {
          'foundryvtt-mcp': {
            generation: {
              prompt: 'p',
              seed: 42,
              quality: 'medium',
              width: 1536,
              height: 1536,
              gridSize: 70,
            },
          },
        },
      },
    ]);
    manager.dispose();
  });

  it('fails with the ComfyUI error, and after three polls where the job is unknown', async () => {
    const a = setup([{ state: 'failed', error: 'CUDA out of memory' }]);
    const failed = await a.manager.start({ prompt: 'p', sceneName: 'S' });
    await a.manager.advance(failed);
    expect(failed).toMatchObject({ status: 'failed', error: 'CUDA out of memory' });

    const b = setup([{ state: 'unknown' }, { state: 'unknown' }, { state: 'unknown' }]);
    const lost = await b.manager.start({ prompt: 'p', sceneName: 'S' });
    await b.manager.advance(lost);
    await b.manager.advance(lost);
    expect(lost.status).toBe('queued');
    await b.manager.advance(lost);
    expect(lost.status).toBe('failed');
    expect(lost.error).toContain('no longer knows');
    a.manager.dispose();
    b.manager.dispose();
  });

  it('keeps going after a network blip, but gives up after the timeout', async () => {
    vi.useFakeTimers();
    const { manager, comfy } = setup([]);
    vi.mocked(comfy.getStatus).mockRejectedValueOnce(new Error('ECONNRESET'));
    const job = await manager.start({ prompt: 'p', sceneName: 'S' });
    await manager.advance(job);
    expect(job.status).toBe('queued');
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    await manager.advance(job);
    expect(job).toMatchObject({ status: 'failed', error: expect.stringContaining('Gave up') });
    manager.dispose();
  });

  it('reports a failed import with the uploaded path, and cancels running jobs', async () => {
    const { manager, foundry, comfy } = setup([{ state: 'complete' }]);
    vi.mocked(foundry.createDocuments).mockRejectedValueOnce(new Error('Scene rejected'));
    const job = await manager.start({ prompt: 'p', sceneName: 'S' });
    await manager.advance(job);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Scene rejected');
    expect(job.error).toContain(job.imagePath as string);
    await expect(manager.cancel(job.id)).rejects.toThrow(/already finished/);

    const live = await manager.start({ prompt: 'p', sceneName: 'T' });
    await manager.cancel(live.id);
    expect(comfy.cancel).toHaveBeenCalledWith('prompt-1');
    expect(live.status).toBe('cancelled');
    manager.dispose();
  });
});
