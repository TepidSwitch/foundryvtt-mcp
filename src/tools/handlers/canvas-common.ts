/**
 * @fileoverview Shared helpers for canvas editing (walls, regions, tiles, drawings)
 *
 * Callers give positions in grid squares from the top-left corner of the map
 * image, like foundry_tokens_edit place. Foundry stores canvas pixels, which
 * include the scene padding and any shift; sceneOrigin() accounts for that.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { sceneOrigin } from '../../foundry/import.js';
import type { WorldScene } from '../../foundry/types.js';
import { at, isRec, num, type Rec, str } from './dnd5e.js';
import { snapshotOf } from './refs.js';
import { resolveScene } from './scenes.js';

export function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

export interface Geometry {
  scene: WorldScene;
  size: number;
  cols: number;
  rows: number;
  originX: number;
  originY: number;
}

export function geometryOf(scene: WorldScene): Geometry {
  const raw = scene as unknown as Rec;
  const size = num(at(scene, 'grid', 'size'), 100) || 100;
  const origin = sceneOrigin({
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    gridSize: size,
    shiftX: num(raw.shiftX),
    shiftY: num(raw.shiftY),
  });
  return {
    scene,
    size,
    cols: Math.round(scene.width / size),
    rows: Math.round(scene.height / size),
    originX: origin.x,
    originY: origin.y,
  };
}

export function sceneFor(foundryClient: FoundryClient, ref: string): Geometry {
  return geometryOf(resolveScene(snapshotOf(foundryClient), ref));
}

/** Grid-square position (fractions allowed) to canvas pixels. */
export function px(g: Geometry, col: number, row: number): { x: number; y: number } {
  return { x: g.originX + col * g.size, y: g.originY + row * g.size };
}

/** Canvas pixels back to grid squares, rounded to 2 decimals for display. */
export function squares(g: Geometry, x: number, y: number): [number, number] {
  const r = (v: number) => Math.round(v * 100) / 100;
  return [r((x - g.originX) / g.size), r((y - g.originY) / g.size)];
}

/** A length in squares to pixels. */
export function len(g: Geometry, n: number): number {
  return n * g.size;
}

/** Throws unless (col,row) lies on the map; edges count (walls sit on grid lines). */
export function assertOnMap(g: Geometry, col: number, row: number, what = 'Point'): void {
  if (!(col >= 0 && row >= 0 && col <= g.cols && row <= g.rows)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${what} (${col}, ${row}) is outside the map: columns 0-${g.cols}, rows 0-${g.rows} (grid squares from the top-left)`,
    );
  }
}

/** The scene's embedded documents of one kind, as plain records. */
export function embeddedOf(
  scene: WorldScene,
  field: 'walls' | 'tiles' | 'regions' | 'drawings',
): Rec[] {
  const list = (scene as unknown as Rec)[field];
  return (Array.isArray(list) ? list : []).filter(isRec);
}

/** One embedded document by id, or a clear error. */
export function findEmbedded(
  g: Geometry,
  field: 'walls' | 'tiles' | 'regions' | 'drawings',
  ref: string,
): Rec {
  const docs = embeddedOf(g.scene, field);
  const byId = docs.find((d) => d._id === ref);
  if (byId) {
    return byId;
  }
  const noun = field.slice(0, -1);
  if (field !== 'walls') {
    const named = docs.filter((d) => str(d.name).toLowerCase() === ref.toLowerCase() && ref !== '');
    if (named.length === 1 && named[0]) {
      return named[0];
    }
    if (named.length > 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `"${ref}" matches ${named.length} ${field} on "${g.scene.name}" - use an id (foundry_canvas list)`,
      );
    }
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `No ${noun} "${ref}" on "${g.scene.name}". Ids are listed by foundry_canvas list.`,
  );
}

export function pageLimit(limit: number | undefined, fallback = 40): number {
  return Math.min(Math.max(Math.round(limit ?? fallback), 1), 200);
}
