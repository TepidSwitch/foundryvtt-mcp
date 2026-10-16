/**
 * @fileoverview Tiles: images placed on a scene (props, roofs, overlays)
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import {
  assertOnMap,
  embeddedOf,
  findEmbedded,
  type Geometry,
  len,
  pageLimit,
  px,
  sceneFor,
  squares,
  text,
} from './canvas-common.js';
import { num, type Rec, str } from './dnd5e.js';
import { withToolError } from './utils.js';

export interface TileFields {
  rotation?: number | undefined;
  alpha?: number | undefined;
  hidden?: boolean | undefined;
  locked?: boolean | undefined;
  elevation?: number | undefined;
  sort?: number | undefined;
}

function common(f: TileFields): Rec {
  const out: Rec = {};
  for (const k of ['rotation', 'alpha', 'hidden', 'locked', 'elevation', 'sort'] as const) {
    if (f[k] !== undefined) {
      out[k] = f[k];
    }
  }
  return out;
}

export async function handleAddTile(
  args: {
    scene: string;
    image: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } & TileFields,
  foundryClient: FoundryClient,
) {
  return withToolError('add tile', async () => {
    if (!(args.width > 0 && args.height > 0)) {
      throw new McpError(ErrorCode.InvalidParams, 'width and height must be positive (in squares)');
    }
    const g = sceneFor(foundryClient, args.scene);
    assertOnMap(g, args.x, args.y, 'Tile position');
    const p = px(g, args.x, args.y);
    const data: Rec = {
      texture: { src: args.image },
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: Math.round(len(g, args.width)),
      height: Math.round(len(g, args.height)),
      ...common(args),
    };
    const [created] = await foundryClient.createDocuments('Tile', [data], `Scene.${g.scene._id}`);
    return text(
      `🖼️ **Tile Added** on "${g.scene.name}" at ${args.x},${args.y} (${args.width}×${args.height} squares)\n**Image:** \`${args.image}\`\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleUpdateTile(
  args: {
    scene: string;
    tile: string;
    image?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } & TileFields,
  foundryClient: FoundryClient,
) {
  return withToolError('update tile', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const tile = findEmbedded(g, 'tiles', args.tile);
    const patch: Rec = common(args);
    if (args.image !== undefined) {
      patch['texture.src'] = args.image;
    }
    if ((args.x === undefined) !== (args.y === undefined)) {
      throw new McpError(ErrorCode.InvalidParams, 'Give both x and y to move a tile');
    }
    if (args.x !== undefined && args.y !== undefined) {
      assertOnMap(g, args.x, args.y, 'Tile position');
      const p = px(g, args.x, args.y);
      patch.x = Math.round(p.x);
      patch.y = Math.round(p.y);
    }
    if (args.width !== undefined) {
      patch.width = Math.round(len(g, args.width));
    }
    if (args.height !== undefined) {
      patch.height = Math.round(len(g, args.height));
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments(
      'Tile',
      [{ _id: str(tile._id), ...patch }],
      `Scene.${g.scene._id}`,
    );
    return text(
      `✏️ **Tile Updated** \`${str(tile._id)}\` on "${g.scene.name}": ${Object.keys(patch).join(', ')}`,
    );
  });
}

export async function handleRemoveTile(
  args: { scene: string; tile: string },
  foundryClient: FoundryClient,
) {
  return withToolError('remove tile', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const tile = findEmbedded(g, 'tiles', args.tile);
    await foundryClient.deleteDocuments('Tile', [str(tile._id)], `Scene.${g.scene._id}`);
    return text(
      `🗑️ **Tile Removed** \`${str(tile._id)}\` from "${g.scene.name}". Undo with foundry_history_edit undo.`,
    );
  });
}

export function listTiles(g: Geometry, limit?: number): string {
  const tiles = embeddedOf(g.scene, 'tiles');
  const max = pageLimit(limit);
  const lines = tiles.slice(0, max).map((t) => {
    const at = squares(g, num(t.x), num(t.y));
    const src = str((t.texture as Rec | undefined)?.src);
    return `- \`${str(t._id)}\` ${src.split('/').pop() || '(no image)'} at (${at.join(', ')}) ${Math.round((num(t.width) / g.size) * 100) / 100}×${Math.round((num(t.height) / g.size) * 100) / 100} sq${t.hidden === true ? ' · hidden' : ''}${t.locked === true ? ' · locked' : ''}`;
  });
  return `🖼️ **Tiles on "${g.scene.name}"** (${tiles.length})\n${lines.join('\n') || '_None._'}${tiles.length > max ? `\n_Showing ${max} of ${tiles.length}._` : ''}`;
}
