import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import type { ComfyUIClient } from '../../../generate/comfyui.js';
import type { MapJob, MapJobManager } from '../../../generate/map-jobs.js';
import type { ToolContext } from '../../base.js';
import { handleCancelMap, handleGenerateMap, handleMapStatus } from '../map-generation.js';

const job = (over: Partial<MapJob> = {}): MapJob => ({
  id: 'map-1',
  promptId: 'p1',
  status: 'generating',
  sceneName: 'Crystal Caverns',
  prompt: 'x',
  width: 1536,
  height: 1536,
  gridSize: 70,
  createdAt: Date.now() - 30_000,
  updatedAt: Date.now(),
  ...over,
});

function ctx(health: { available: boolean; error?: string; gpu?: string }, jobs: MapJob[] = []) {
  const start = vi.fn(async () => job({ status: 'queued' }));
  const maps = {
    start,
    get: (id: string) => jobs.find((j) => j.id === id),
    list: () => jobs,
    cancel: vi.fn(async () => job({ status: 'cancelled' })),
  } as unknown as MapJobManager;
  const context: ToolContext = {
    foundryClient: {
      getWorldSnapshot: () => ({
        folders: [{ _id: 'FOLDERAAAAAAAAAA', name: 'Maps', type: 'Scene' }],
      }),
    } as unknown as FoundryClient,
    comfyui: {
      baseUrl: 'http://gpu:8188',
      checkHealth: async () => health,
    } as unknown as ComfyUIClient,
    maps,
  };
  return { context, start, maps };
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('map generation handlers', () => {
  it('explains how to set up ComfyUI when it is not configured', async () => {
    const bare: ToolContext = { foundryClient: {} as FoundryClient };
    await expect(handleGenerateMap({ prompt: 'x', scene_name: 'S' }, bare)).rejects.toThrow(
      /COMFYUI_URL/,
    );
    expect(textOf(await handleMapStatus({}, bare))).toContain('COMFYUI_URL');
  });

  it('refuses to start when ComfyUI is unreachable, with the fix', async () => {
    const { context, start } = ctx({
      available: false,
      error: 'cannot reach ComfyUI (ECONNREFUSED)',
    });
    await expect(handleGenerateMap({ prompt: 'x', scene_name: 'S' }, context)).rejects.toThrow(
      /--listen 0\.0\.0\.0.*8188/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a job and tells the model not to poll', async () => {
    const { context, start } = ctx({ available: true, gpu: 'RTX 4070' });
    const out = textOf(
      await handleGenerateMap(
        {
          prompt: 'a cave',
          scene_name: 'Crystal Caverns',
          size: 'small',
          quality: 'medium',
          folder: 'Maps',
        },
        context,
      ),
    );
    expect(start).toHaveBeenCalledWith({
      prompt: 'a cave',
      sceneName: 'Crystal Caverns',
      size: 'small',
      quality: 'medium',
      folderId: 'FOLDERAAAAAAAAAA',
    });
    expect(out).toContain('RTX 4070');
    expect(out).toContain('`map-1`');
    expect(out).toContain('Do not poll');
  });

  it('describes job states and lists recent jobs', async () => {
    const done = job({
      id: 'map-2',
      status: 'done',
      sceneId: 'SCENEAAAAAAAAAAA',
      imagePath: 'worlds/w/x.png',
    });
    const failed = job({ id: 'map-3', status: 'failed', error: 'CUDA out of memory' });
    const { context } = ctx({ available: true }, [done, failed]);
    expect(textOf(await handleMapStatus({ job_id: 'map-2' }, context))).toContain(
      'SCENEAAAAAAAAAAA',
    );
    expect(textOf(await handleMapStatus({ job_id: 'map-3' }, context))).toContain(
      'CUDA out of memory',
    );
    expect(textOf(await handleMapStatus({}, context))).toContain('Map jobs');
    await expect(handleMapStatus({ job_id: 'nope' }, context)).rejects.toThrow(/No map job nope/);
    expect(textOf(await handleCancelMap({ job_id: 'map-1' }, context))).toContain('Cancelled');
  });
});
