/**
 * @fileoverview AI battlemap generation tools (ComfyUI)
 *
 * Prompt guidance and defaults follow the foundry-vtt-mcp bridge by adambdooley
 * (MIT licence).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MapSize } from '../../generate/comfyui.js';
import type { MapJob } from '../../generate/map-jobs.js';
import type { ToolContext } from '../base.js';
import { ensureFolder } from './folders.js';
import { resolveFolder } from './import-place.js';
import { snapshotOf } from './refs.js';
import { withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

const NOT_CONFIGURED =
  'AI map generation is not set up. It needs a ComfyUI server (free, self-hosted, with an SDXL battlemap model): set COMFYUI_URL, e.g. http://192.168.1.50:8188. See docs/guides/fork-setup.md.';

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

export function describeJob(job: MapJob): string {
  const head = `**${job.sceneName}** \`${job.id}\` — started ${ago(job.createdAt)}`;
  switch (job.status) {
    case 'queued':
      return `${head}\n⏳ Waiting in ComfyUI's queue${job.queuePosition ? ` (position ${job.queuePosition})` : ''}.`;
    case 'generating':
      return `${head}\n🎨 Rendering in ComfyUI.`;
    case 'importing':
      return `${head}\n📥 Rendered; uploading to Foundry and creating the scene.`;
    case 'done':
      return `${head}\n✅ Done. Scene created (inactive)${job.sceneId ? `: \`${job.sceneId}\`` : ''}${job.imagePath ? `\nImage: \`${job.imagePath}\`` : ''}\nActivate it with foundry_scenes_edit activate when ready; look at it with foundry_scenes image.`;
    case 'cancelled':
      return `${head}\n🛑 Cancelled.`;
    case 'failed':
      return `${head}\n❌ Failed: ${job.error ?? 'unknown error'}`;
  }
}

export async function handleGenerateMap(
  args: {
    prompt: string;
    scene_name: string;
    size?: MapSize;
    width?: number;
    height?: number;
    grid_size?: number;
    quality?: 'low' | 'medium' | 'high';
    seed?: number;
    cfg?: number;
    avoid?: string;
    create_scene?: boolean;
    folder?: string;
  },
  ctx: ToolContext,
) {
  return withToolError('generate map', async () => {
    if (!ctx.maps || !ctx.comfyui) {
      throw new McpError(ErrorCode.InvalidRequest, NOT_CONFIGURED);
    }
    const health = await ctx.comfyui.checkHealth();
    if (!health.available) {
      throw new McpError(
        ErrorCode.InternalError,
        `ComfyUI at ${ctx.comfyui.baseUrl} is not reachable (${health.error}). Start ComfyUI with --listen 0.0.0.0, and allow TCP 8188 through the firewall on that machine.`,
      );
    }
    const folderId = args.folder
      ? resolveFolder(snapshotOf(ctx.foundryClient), args.folder, 'Scene')
      : ctx.sceneFolder
        ? await ensureFolder(ctx.foundryClient, ctx.sceneFolder, 'Scene')
        : undefined;
    const job = await ctx.maps.start({
      prompt: args.prompt,
      sceneName: args.scene_name,
      ...(args.size ? { size: args.size } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.grid_size !== undefined ? { gridSize: args.grid_size } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.cfg !== undefined ? { cfg: args.cfg } : {}),
      ...(args.avoid ? { avoid: args.avoid } : {}),
      ...(args.create_scene === false ? { createScene: false } : {}),
      ...(folderId ? { folderId } : {}),
    });
    return text(
      `🗺️ **Map generation started**${health.gpu ? ` on ${health.gpu}` : ''}\n**Job:** \`${job.id}\`\n**Scene name:** ${job.sceneName}\n**Size:** ${job.width}×${job.height}px, ${job.gridSize}px per 5 ft square (≈${Math.round(job.width / job.gridSize)}×${Math.round(job.height / job.gridSize)} squares)\n\nThe render runs in the background. ${job.createScene ? 'When it finishes, the image is uploaded and an inactive scene is created automatically.' : 'Render only: nothing is uploaded and no scene is created; map_status gives the file name.'} Low quality takes about a minute on a decent GPU, high several minutes. Do not poll: check foundry_generate map_status only if the user asks.`,
    );
  });
}

export async function handleImportMap(
  args: { path: string; scene_name: string; grid_size?: number; folder?: string },
  ctx: ToolContext,
) {
  return withToolError('import map', async () => {
    if (!ctx.maps) {
      throw new McpError(ErrorCode.InvalidRequest, NOT_CONFIGURED);
    }
    const folderId = args.folder
      ? resolveFolder(snapshotOf(ctx.foundryClient), args.folder, 'Scene')
      : ctx.sceneFolder
        ? await ensureFolder(ctx.foundryClient, ctx.sceneFolder, 'Scene')
        : undefined;
    const job = await ctx.maps.importImage({
      path: args.path,
      sceneName: args.scene_name,
      ...(args.grid_size !== undefined ? { gridSize: args.grid_size } : {}),
      ...(folderId ? { folderId } : {}),
    });
    return text(describeJob(job));
  });
}

export async function handleMapStatus(args: { job_id?: string }, ctx: ToolContext) {
  return withToolError('map status', async () => {
    if (!ctx.maps) {
      return text(NOT_CONFIGURED);
    }
    if (args.job_id) {
      const job = ctx.maps.get(args.job_id);
      if (!job) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No map job ${args.job_id}. Jobs are forgotten when the server restarts; call map_status without job_id to list them.`,
        );
      }
      return text(describeJob(job));
    }
    const jobs = ctx.maps.list().slice(0, 10);
    return text(
      jobs.length === 0
        ? '🗺️ No map jobs since the server started.'
        : `🗺️ **Map jobs** (newest first)\n\n${jobs.map(describeJob).join('\n\n')}`,
    );
  });
}

export async function handleCancelMap(args: { job_id: string }, ctx: ToolContext) {
  return withToolError('cancel map', async () => {
    if (!ctx.maps) {
      throw new McpError(ErrorCode.InvalidRequest, NOT_CONFIGURED);
    }
    const job = await ctx.maps.cancel(args.job_id);
    return text(describeJob(job));
  });
}
