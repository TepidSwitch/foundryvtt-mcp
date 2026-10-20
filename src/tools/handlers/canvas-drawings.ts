/**
 * @fileoverview Drawings: shapes and text labels drawn on a scene
 *
 * v14 drawing shape types are single letters: r (rectangle), e (ellipse),
 * p (polygon, points relative to x,y). fillType: NONE 0, SOLID 1, PATTERN 2.
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
  pageSlice,
  px,
  sceneFor,
  squares,
  text,
} from './canvas-common.js';
import { num, type Rec, str } from './dnd5e.js';
import { withToolError } from './utils.js';

export type DrawingShape = 'rectangle' | 'ellipse' | 'polygon' | 'text';

export interface DrawingStyle {
  fill?: 'none' | 'solid' | undefined;
  fill_color?: string | undefined;
  fill_alpha?: number | undefined;
  stroke_width?: number | undefined;
  stroke_color?: string | undefined;
  stroke_alpha?: number | undefined;
  text?: string | undefined;
  font_size?: number | undefined;
  text_color?: string | undefined;
  hidden?: boolean | undefined;
  locked?: boolean | undefined;
  elevation?: number | undefined;
}

const FILL = { none: 0, solid: 1 } as const;

function style(s: DrawingStyle): Rec {
  const out: Rec = {};
  if (s.fill !== undefined) {
    out.fillType = FILL[s.fill];
  }
  const map: Array<[keyof DrawingStyle, string]> = [
    ['fill_color', 'fillColor'],
    ['fill_alpha', 'fillAlpha'],
    ['stroke_width', 'strokeWidth'],
    ['stroke_color', 'strokeColor'],
    ['stroke_alpha', 'strokeAlpha'],
    ['text', 'text'],
    ['font_size', 'fontSize'],
    ['text_color', 'textColor'],
    ['hidden', 'hidden'],
    ['locked', 'locked'],
    ['elevation', 'elevation'],
  ];
  for (const [from, to] of map) {
    if (s[from] !== undefined) {
      out[to] = s[from];
    }
  }
  return out;
}

export async function handleAddDrawing(
  args: {
    scene: string;
    shape: DrawingShape;
    x: number;
    y: number;
    width?: number;
    height?: number;
    points?: number[];
  } & DrawingStyle,
  foundryClient: FoundryClient,
) {
  return withToolError('add drawing', async () => {
    const g = sceneFor(foundryClient, args.scene);
    assertOnMap(g, args.x, args.y, 'Drawing position');
    const origin = px(g, args.x, args.y);
    let shape: Rec;
    if (args.shape === 'polygon') {
      const pts = args.points ?? [];
      if (pts.length < 4 || pts.length % 2 !== 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'A polygon needs points as [x1, y1, x2, y2, ...] in squares, with at least 2 points',
        );
      }
      // Points are relative to the drawing's x,y, in pixels.
      const rel = pts.map((v, i) => Math.round(len(g, v - (i % 2 === 0 ? args.x : args.y))));
      const xs = rel.filter((_, i) => i % 2 === 0);
      const ys = rel.filter((_, i) => i % 2 === 1);
      shape = {
        type: 'p',
        width: Math.max(...xs) - Math.min(0, ...xs),
        height: Math.max(...ys) - Math.min(0, ...ys),
        points: rel,
      };
    } else {
      if (!(args.width && args.height && args.width > 0 && args.height > 0)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `A ${args.shape} needs a positive width and height (squares)`,
        );
      }
      shape = {
        type: args.shape === 'ellipse' ? 'e' : 'r',
        width: Math.round(len(g, args.width)),
        height: Math.round(len(g, args.height)),
      };
    }
    const label = args.shape === 'text';
    if (label && !args.text) {
      throw new McpError(ErrorCode.InvalidParams, 'A text drawing needs text');
    }
    const author = foundryClient.getUserId();
    const data: Rec = {
      shape,
      x: Math.round(origin.x),
      y: Math.round(origin.y),
      // A text label is an invisible rectangle carrying the text.
      ...(label ? { fillType: 0, strokeWidth: 0 } : {}),
      ...style(args),
      ...(author ? { author } : {}),
    };
    const [created] = await foundryClient.createDocuments(
      'Drawing',
      [data],
      `Scene.${g.scene._id}`,
    );
    return text(
      `✏️ **Drawing Added** (${args.shape}) on "${g.scene.name}" at ${args.x},${args.y}${args.text ? `: "${args.text}"` : ''}\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleUpdateDrawing(
  args: { scene: string; drawing: string; x?: number; y?: number } & DrawingStyle,
  foundryClient: FoundryClient,
) {
  return withToolError('update drawing', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const drawing = findEmbedded(g, 'drawings', args.drawing);
    const patch = style(args);
    if ((args.x === undefined) !== (args.y === undefined)) {
      throw new McpError(ErrorCode.InvalidParams, 'Give both x and y to move a drawing');
    }
    if (args.x !== undefined && args.y !== undefined) {
      assertOnMap(g, args.x, args.y, 'Drawing position');
      const p = px(g, args.x, args.y);
      patch.x = Math.round(p.x);
      patch.y = Math.round(p.y);
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments(
      'Drawing',
      [{ _id: str(drawing._id), ...patch }],
      `Scene.${g.scene._id}`,
    );
    return text(`✏️ **Drawing Updated** \`${str(drawing._id)}\`: ${Object.keys(patch).join(', ')}`);
  });
}

export async function handleRemoveDrawing(
  args: { scene: string; drawing: string },
  foundryClient: FoundryClient,
) {
  return withToolError('remove drawing', async () => {
    const g = sceneFor(foundryClient, args.scene);
    const drawing = findEmbedded(g, 'drawings', args.drawing);
    await foundryClient.deleteDocuments('Drawing', [str(drawing._id)], `Scene.${g.scene._id}`);
    return text(
      `🗑️ **Drawing Removed** \`${str(drawing._id)}\` from "${g.scene.name}". Undo with foundry_history_edit undo.`,
    );
  });
}

export function listDrawings(g: Geometry, limit?: number, offset?: number): string {
  const drawings = embeddedOf(g.scene, 'drawings');
  const page = pageSlice(drawings, pageLimit(limit), offset);
  const kinds: Record<string, string> = {
    r: 'rectangle',
    e: 'ellipse',
    p: 'polygon',
    f: 'freehand',
  };
  const lines = page.items.map((d) => {
    const shape = (d.shape ?? {}) as Rec;
    return `- \`${str(d._id)}\` ${kinds[str(shape.type)] ?? str(shape.type)} at (${squares(g, num(d.x), num(d.y)).join(', ')})${d.text ? ` "${str(d.text)}"` : ''}${d.hidden === true ? ' · hidden' : ''}`;
  });
  return `✏️ **Drawings on "${g.scene.name}"** (${drawings.length})\n${lines.join('\n') || '_None._'}${page.footer}`;
}
