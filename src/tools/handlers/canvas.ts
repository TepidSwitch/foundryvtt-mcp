/**
 * @fileoverview foundry_canvas list: ids and positions of walls, regions, tiles, drawings
 */

import type { FoundryClient } from '../../foundry/client.js';
import { sceneFor, text } from './canvas-common.js';
import { listDrawings } from './canvas-drawings.js';
import { listRegions } from './canvas-regions.js';
import { listTiles } from './canvas-tiles.js';
import { listWalls } from './canvas-walls.js';
import { withToolError } from './utils.js';

export type CanvasKind = 'walls' | 'regions' | 'tiles' | 'drawings';

export async function handleCanvasList(
  args: {
    scene: string;
    kind: CanvasKind;
    filter?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    limit?: number;
    offset?: number;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('list canvas', async () => {
    const g = sceneFor(foundryClient, args.scene);
    switch (args.kind) {
      case 'walls': {
        const hasArea = [args.x, args.y, args.width, args.height].every((v) => v !== undefined);
        return text(
          listWalls(g, {
            filter: args.filter,
            limit: args.limit,
            offset: args.offset,
            area: hasArea
              ? {
                  x: args.x as number,
                  y: args.y as number,
                  width: args.width as number,
                  height: args.height as number,
                }
              : undefined,
          }),
        );
      }
      case 'regions':
        return text(listRegions(g, args.limit, args.offset));
      case 'tiles':
        return text(listTiles(g, args.limit, args.offset));
      case 'drawings':
        return text(listDrawings(g, args.limit, args.offset));
    }
  });
}
