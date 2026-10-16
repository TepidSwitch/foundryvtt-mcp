/**
 * @fileoverview Regions: scene areas with shapes (v14; replaces MeasuredTemplates)
 *
 * Shape data follows the v14 shape models: rectangle (x, y, width, height),
 * circle (x, y, radius), ellipse (x, y, radiusX, radiusY), cone (x, y, radius,
 * angle, rotation), ring (x, y, radius, innerWidth, outerWidth) and polygon
 * (points). Callers use grid squares; this converts to canvas pixels.
 * Region BEHAVIORS (teleport, scripts, ...) are not created here on purpose.
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

export interface RegionShapeSpec {
  type: 'rectangle' | 'circle' | 'ellipse' | 'cone' | 'ring' | 'polygon';
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  radius?: number | undefined;
  radius_x?: number | undefined;
  radius_y?: number | undefined;
  angle?: number | undefined;
  rotation?: number | undefined;
  inner_width?: number | undefined;
  outer_width?: number | undefined;
  points?: number[] | undefined;
  hole?: boolean | undefined;
}

const VISIBILITY = { layer: 0, gamemaster: 1, always: 2, observer: 3, layer_unlocked: 4 } as const;
export type RegionVisibility = keyof typeof VISIBILITY;

function need(shape: RegionShapeSpec, ...fields: Array<keyof RegionShapeSpec>): void {
  const missing = fields.filter((f) => shape[f] === undefined);
  if (missing.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `A ${shape.type} region shape needs ${missing.join(', ')}`,
    );
  }
}

export function buildShape(g: Geometry, s: RegionShapeSpec): Rec {
  const hole = s.hole ?? false;
  if (s.type === 'polygon') {
    const pts = s.points ?? [];
    if (pts.length < 6 || pts.length % 2 !== 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'A polygon needs points as [x1, y1, x2, y2, x3, y3, ...] with at least 3 points',
      );
    }
    const points: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      assertOnMap(g, pts[i] as number, pts[i + 1] as number, 'Polygon point');
      const p = px(g, pts[i] as number, pts[i + 1] as number);
      points.push(p.x, p.y);
    }
    return { type: 'polygon', hole, points };
  }
  need(s, 'x', 'y');
  const origin = px(g, s.x as number, s.y as number);
  assertOnMap(g, s.x as number, s.y as number, `${s.type} position`);
  const base = { type: s.type, hole, x: origin.x, y: origin.y, gridBased: false };
  switch (s.type) {
    case 'rectangle':
      need(s, 'width', 'height');
      return {
        ...base,
        width: len(g, s.width as number),
        height: len(g, s.height as number),
        rotation: s.rotation ?? 0,
        anchorX: 0,
        anchorY: 0,
      };
    case 'circle':
      need(s, 'radius');
      return { ...base, radius: len(g, s.radius as number) };
    case 'ellipse':
      need(s, 'radius_x', 'radius_y');
      return {
        ...base,
        radiusX: len(g, s.radius_x as number),
        radiusY: len(g, s.radius_y as number),
        rotation: s.rotation ?? 0,
      };
    case 'cone':
      need(s, 'radius', 'angle');
      return {
        ...base,
        radius: len(g, s.radius as number),
        angle: s.angle as number,
        rotation: s.rotation ?? 0,
        curvature: 'round',
      };
    case 'ring':
      need(s, 'radius', 'inner_width', 'outer_width');
      return {
        ...base,
        radius: len(g, s.radius as number),
        innerWidth: len(g, s.inner_width as number),
        outerWidth: len(g, s.outer_width as number),
      };
  }
}

export interface RegionFields {
  color?: string | undefined;
  hidden?: boolean | undefined;
  locked?: boolean | undefined;
  visibility?: RegionVisibility | undefined;
  display_measurements?: boolean | undefined;
  elevation_bottom?: number | null | undefined;
  elevation_top?: number | null | undefined;
}

function fieldUpdates(f: RegionFields): Rec {
  const out: Rec = {};
  if (f.color !== undefined) {
    out.color = f.color;
  }
  if (f.hidden !== undefined) {
    out.hidden = f.hidden;
  }
  if (f.locked !== undefined) {
    out.locked = f.locked;
  }
  if (f.visibility !== undefined) {
    out.visibility = VISIBILITY[f.visibility];
  }
  if (f.display_measurements !== undefined) {
    out.displayMeasurements = f.display_measurements;
  }
  if (f.elevation_bottom !== undefined) {
    out['elevation.bottom'] = f.elevation_bottom;
  }
  if (f.elevation_top !== undefined) {
    out['elevation.top'] = f.elevation_top;
  }
  return out;
}

export async function handleAddRegion(
  args: { scene: string; name: string; shapes: RegionShapeSpec[] } & RegionFields,
  foundryClient: FoundryClient,
) {
  return withToolError('add region', async () => {
    if (args.shapes.length === 0 || args.shapes.length > 50) {
      throw new McpError(ErrorCode.InvalidParams, 'Give between 1 and 50 shapes');
    }
    const g = sceneFor(foundryClient, args.scene);
    const data: Rec = { name: args.name, shapes: args.shapes.map((s) => buildShape(g, s)) };
    const fields = fieldUpdates(args);
    // Dotted keys are for updates; on create nest the elevation object.
    const elevation: Rec = {};
    if ('elevation.bottom' in fields) {
      elevation.bottom = fields['elevation.bottom'];
    }
    if ('elevation.top' in fields) {
      elevation.top = fields['elevation.top'];
    }
    delete fields['elevation.bottom'];
    delete fields['elevation.top'];
    Object.assign(data, fields);
    if (Object.keys(elevation).length > 0) {
      data.elevation = elevation;
    }
    const [created] = await foundryClient.createDocuments('Region', [data], `Scene.${g.scene._id}`);
    return text(
      `🔷 **Region Added** "${args.name}" on "${g.scene.name}" (${args.shapes.map((s) => s.type).join(', ')})\n**ID:** ${str(created?._id)}\nIt has no behaviors yet; add those in Foundry (teleport, trigger, ...).`,
    );
  });
}

export async function handleUpdateRegion(
  args: { scene: string; region: string; name?: string } & RegionFields,
  foundryClient: FoundryClient,
) {
  return withToolError('update region', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const region = findEmbedded(g, 'regions', args.region);
    const oldName = str(region.name);
    const patch = fieldUpdates(args);
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments(
      'Region',
      [{ _id: str(region._id), ...patch }],
      `Scene.${g.scene._id}`,
    );
    return text(`✏️ **Region Updated** "${oldName}": ${Object.keys(patch).join(', ')}`);
  });
}

export async function handleRemoveRegion(
  args: { scene: string; region: string },
  foundryClient: FoundryClient,
) {
  return withToolError('remove region', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const region = findEmbedded(g, 'regions', args.region);
    const behaviors = Array.isArray(region.behaviors) ? region.behaviors.length : 0;
    await foundryClient.deleteDocuments('Region', [str(region._id)], `Scene.${g.scene._id}`);
    return text(
      `🗑️ **Region Removed** "${str(region.name)}" from "${g.scene.name}"${behaviors ? ` (it had ${behaviors} behavior(s))` : ''}. Undo with foundry_history_edit undo.`,
    );
  });
}

export function listRegions(g: Geometry, limit?: number): string {
  const regions = embeddedOf(g.scene, 'regions');
  const max = pageLimit(limit);
  const lines = regions.slice(0, max).map((r) => {
    const shapes = (Array.isArray(r.shapes) ? r.shapes : []) as Rec[];
    const first = shapes[0];
    const where =
      first && typeof first.x === 'number' && typeof first.y === 'number'
        ? ` at (${squares(g, first.x, first.y).join(', ')})`
        : '';
    const behaviors = Array.isArray(r.behaviors) ? r.behaviors.length : 0;
    return `- **${str(r.name)}** \`${str(r._id)}\` — ${[...new Set(shapes.map((s) => str(s.type)))].join('/') || 'no shapes'} ×${shapes.length}${where}${behaviors ? ` · ${behaviors} behavior(s)` : ''}${r.hidden === true ? ' · hidden' : ''}${r.locked === true ? ' · locked' : ''}${num(r.visibility) !== 4 ? ` · visibility ${num(r.visibility)}` : ''}`;
  });
  return `🔷 **Regions on "${g.scene.name}"** (${regions.length})\n${lines.join('\n') || '_None._'}${regions.length > max ? `\n_Showing ${max} of ${regions.length}._` : ''}`;
}
