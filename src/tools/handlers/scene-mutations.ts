/**
 * @fileoverview Scene edits: activate, settings, map notes, ambient lights
 *
 * Positions are given in grid squares from the top-left of the map image (like
 * foundry_tokens_edit place) and converted to canvas pixels at the centre of
 * that square; fractions shift within or between squares.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { sceneSquares, squareToPixels } from '../../foundry/import.js';
import type { WorldScene } from '../../foundry/types.js';
import { at, isRec, num, type Rec, str } from './dnd5e.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { resolveScene } from './scenes.js';
import { withToolError } from './utils.js';

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function geometryOf(scene: WorldScene) {
  const raw = scene as unknown as Rec;
  return {
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    gridSize: num(at(scene, 'grid', 'size'), 100) || 100,
    shiftX: num(raw.shiftX),
    shiftY: num(raw.shiftY),
  };
}

/** Canvas pixel position of the centre of grid square (col,row) of a scene. */
function squareCentre(scene: WorldScene, col: number, row: number): { x: number; y: number } {
  const g = geometryOf(scene);
  const { cols, rows } = sceneSquares(g);
  if (col < 0 || row < 0 || col >= cols || row >= rows) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `(${col}, ${row}) is outside the map: columns 0-${cols - 1}, rows 0-${rows - 1}`,
    );
  }
  const p = squareToPixels(g, Math.floor(col), Math.floor(row));
  const size = g.gridSize;
  return {
    x: Math.round(p.x + (col - Math.floor(col)) * size + size / 2),
    y: Math.round(p.y + (row - Math.floor(row)) * size + size / 2),
  };
}

function embedded(scene: WorldScene, field: 'notes' | 'lights'): Rec[] {
  const list = (scene as unknown as Rec)[field];
  return (Array.isArray(list) ? list : []).filter(isRec);
}

/** A note by id or label, a light by id or name. */
function findEmbedded(scene: WorldScene, field: 'notes' | 'lights', ref: string): Rec {
  const label = field === 'notes' ? 'text' : 'name';
  const docs = embedded(scene, field);
  const byId = docs.find((d) => d._id === ref);
  if (byId) {
    return byId;
  }
  const matches = docs.filter((d) => str(d[label]).toLowerCase() === ref.toLowerCase());
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  const noun = field === 'notes' ? 'map note' : 'light';
  throw new McpError(
    ErrorCode.InvalidParams,
    matches.length > 1
      ? `"${ref}" matches ${matches.length} ${noun}s — use an id (see foundry_scenes get)`
      : `No ${noun} on "${scene.name}" matches "${ref}". Ids are listed by foundry_scenes get.`,
  );
}

// ---------------------------------------------------------------------------

export async function handleActivateScene(args: { scene: string }, foundryClient: FoundryClient) {
  return withToolError('activate scene', async () => {
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    if (scene.active) {
      return text(`🗺️ "${scene.name}" is already the active scene.`);
    }
    await foundryClient.updateDocuments('Scene', [{ _id: scene._id, active: true }]);
    return text(
      `🗺️ **Scene Activated** "${scene.name}" — players are moved to it now. Any other active scene is deactivated.`,
    );
  });
}

export interface SceneSettings {
  name?: string;
  darkness?: number;
  global_light?: boolean;
  navigation?: boolean;
  nav_name?: string;
  token_vision?: boolean;
  fog_exploration?: boolean;
  grid_size?: number;
  grid_distance?: number;
  grid_units?: string;
}

export async function handleUpdateScene(
  args: { scene: string } & SceneSettings,
  foundryClient: FoundryClient,
) {
  return withToolError('update scene', async () => {
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    const patch: Rec = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.navigation !== undefined) {
      patch.navigation = args.navigation;
    }
    if (args.nav_name !== undefined) {
      patch.navName = args.nav_name;
    }
    if (args.token_vision !== undefined) {
      patch.tokenVision = args.token_vision;
    }
    if (args.fog_exploration !== undefined) {
      patch['fog.exploration'] = args.fog_exploration;
    }
    if (args.darkness !== undefined) {
      patch['environment.darknessLevel'] = args.darkness;
    }
    if (args.global_light !== undefined) {
      patch['environment.globalLight.enabled'] = args.global_light;
    }
    if (args.grid_size !== undefined) {
      patch['grid.size'] = args.grid_size;
    }
    if (args.grid_distance !== undefined) {
      patch['grid.distance'] = args.grid_distance;
    }
    if (args.grid_units !== undefined) {
      patch['grid.units'] = args.grid_units;
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one setting to change');
    }
    await foundryClient.updateDocuments('Scene', [{ _id: scene._id, ...patch }]);
    return text(`✏️ **Scene Updated** "${scene.name}": ${Object.keys(patch).join(', ')}`);
  });
}

export async function handleAddNote(
  args: {
    scene: string;
    x: number;
    y: number;
    journal?: string;
    page?: string;
    text?: string;
    icon_size?: number;
    font_size?: number;
    global?: boolean;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('add map note', async () => {
    const snapshot = snapshotOf(foundryClient);
    const scene = resolveScene(snapshot, args.scene);
    const pos = squareCentre(scene, args.x, args.y);
    const data: Rec = { x: pos.x, y: pos.y };
    let linked = '';
    if (args.journal) {
      const journal = resolveByRef(
        snapshot.journal as unknown as Rec[],
        args.journal,
        'journal',
        'foundry_journals search',
      );
      data.entryId = str(journal._id);
      linked = ` → journal "${str(journal.name)}"`;
      if (args.page) {
        const pages = (Array.isArray(journal.pages) ? journal.pages : []).filter(isRec);
        const page = resolveByRef(
          pages,
          args.page,
          `page of "${str(journal.name)}"`,
          'foundry_journals get',
        );
        data.pageId = str(page._id);
      }
    } else if (args.page) {
      throw new McpError(ErrorCode.InvalidParams, 'page needs journal');
    }
    if (args.text !== undefined) {
      data.text = args.text;
    }
    if (args.icon_size !== undefined) {
      data.iconSize = args.icon_size;
    }
    if (args.font_size !== undefined) {
      data.fontSize = args.font_size;
    }
    if (args.global !== undefined) {
      data.global = args.global;
    }
    const [created] = await foundryClient.createDocuments('Note', [data], `Scene.${scene._id}`);
    return text(
      `📍 **Map Note Added** on "${scene.name}" at ${args.x},${args.y}${linked}\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleRemoveNote(
  args: { scene: string; note: string },
  foundryClient: FoundryClient,
) {
  return withToolError('remove map note', async () => {
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    const note = findEmbedded(scene, 'notes', args.note);
    await foundryClient.deleteDocuments('Note', [str(note._id)], `Scene.${scene._id}`);
    return text(
      `🗑️ **Map Note Removed** "${str(note.text) || str(note._id)}" from "${scene.name}". Undo with foundry_history_edit undo.`,
    );
  });
}

export async function handleAddLight(
  args: {
    scene: string;
    x: number;
    y: number;
    name?: string;
    dim?: number;
    bright?: number;
    color?: string;
    angle?: number;
    alpha?: number;
    rotation?: number;
    walls?: boolean;
    vision?: boolean;
    hidden?: boolean;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('add light', async () => {
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    const pos = squareCentre(scene, args.x, args.y);
    const config: Rec = {};
    for (const k of ['dim', 'bright', 'color', 'angle', 'alpha'] as const) {
      if (args[k] !== undefined) {
        config[k] = args[k];
      }
    }
    if (config.dim === undefined && config.bright === undefined) {
      config.dim = 20;
      config.bright = 10;
    }
    const data: Rec = { x: pos.x, y: pos.y, config };
    if (args.name !== undefined) {
      data.name = args.name;
    }
    for (const k of ['rotation', 'walls', 'vision', 'hidden'] as const) {
      if (args[k] !== undefined) {
        data[k] = args[k];
      }
    }
    const [created] = await foundryClient.createDocuments(
      'AmbientLight',
      [data],
      `Scene.${scene._id}`,
    );
    return text(
      `💡 **Light Added** on "${scene.name}" at ${args.x},${args.y} (bright ${String(config.bright ?? 0)}, dim ${String(config.dim ?? 0)} ${str(at(scene, 'grid', 'units'), 'ft')})\n**ID:** ${str(created?._id)}`,
    );
  });
}

export async function handleRemoveLight(
  args: { scene: string; light: string },
  foundryClient: FoundryClient,
) {
  return withToolError('remove light', async () => {
    const scene = resolveScene(snapshotOf(foundryClient), args.scene);
    const light = findEmbedded(scene, 'lights', args.light);
    await foundryClient.deleteDocuments('AmbientLight', [str(light._id)], `Scene.${scene._id}`);
    return text(
      `🗑️ **Light Removed** ${str(light.name) || str(light._id)} from "${scene.name}". Undo with foundry_history_edit undo.`,
    );
  });
}
