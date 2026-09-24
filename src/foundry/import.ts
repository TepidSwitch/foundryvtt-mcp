/**
 * @fileoverview Pure helpers for the additive write tools (compendium import
 * and token placement). No I/O: these build the document data that the client
 * sends through the `modifyDocument` socket event.
 */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The compendium UUID FoundryVTT records as a document's source. */
export function compendiumUuid(packId: string, packType: string, documentId: string): string {
  return `Compendium.${packId}.${packType}.${documentId}`;
}

export interface ImportOptions {
  packId: string;
  packType: string;
  documentId: string;
  /** Override the document name. */
  name?: string;
  /** World folder id for a top-level document (ignored for embedded creation). */
  folder?: string | null;
  /** True when creating as an embedded document (an item on an actor). */
  embedded?: boolean;
}

/**
 * Prepares a compendium document for creation as a new document.
 *
 * Top-level ids, sort order, ownership and folder are dropped so FoundryVTT
 * assigns fresh ones; the compendium origin is recorded in `_stats`. Embedded
 * documents (an actor's items, a scene's tokens and walls) keep their ids:
 * item activities and effects can reference each other by id, and ids only
 * need to be unique within their parent.
 */
export function cleanForImport(doc: Rec, options: ImportOptions): Rec {
  const data = structuredClone(doc) as Rec;
  data._id = undefined;
  data.sort = undefined;
  data.ownership = undefined;
  data._stats = {
    compendiumSource: compendiumUuid(options.packId, options.packType, options.documentId),
  };
  if (options.name) {
    data.name = options.name;
  }
  if (options.embedded) {
    data.folder = undefined;
  } else {
    data.folder = options.folder ?? null;
  }
  // structuredClone keeps `undefined` values; drop them so they are not sent.
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  if (options.packType === 'Scene') {
    // An imported map must never silently become the active scene.
    data.active = false;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Scenes and tokens
// ---------------------------------------------------------------------------

export interface SceneGeometry {
  width: number;
  height: number;
  padding: number;
  gridSize: number;
  shiftX?: number;
  shiftY?: number;
}

/**
 * Pixel offset of the map image's top-left corner inside the canvas. Canvas
 * (token) coordinates include the scene padding, rounded up to whole grid
 * squares, plus any manual shift.
 */
export function sceneOrigin(scene: SceneGeometry): { x: number; y: number } {
  const size = scene.gridSize || 100;
  return {
    x: Math.ceil((scene.padding * scene.width) / size) * size + (scene.shiftX ?? 0),
    y: Math.ceil((scene.padding * scene.height) / size) * size + (scene.shiftY ?? 0),
  };
}

/** Size of the map in whole grid squares. */
export function sceneSquares(scene: SceneGeometry): { cols: number; rows: number } {
  const size = scene.gridSize || 100;
  return { cols: Math.round(scene.width / size), rows: Math.round(scene.height / size) };
}

/** Converts a grid square (0,0 = top-left of the map image) to canvas pixels. */
export function squareToPixels(
  scene: SceneGeometry,
  col: number,
  row: number,
): { x: number; y: number } {
  const origin = sceneOrigin(scene);
  const size = scene.gridSize || 100;
  return { x: origin.x + col * size, y: origin.y + row * size };
}

export const DISPOSITIONS: Record<string, number> = {
  hostile: -1,
  neutral: 0,
  friendly: 1,
};

export interface TokenOptions {
  x: number;
  y: number;
  name?: string;
  hidden?: boolean;
  /** -1 hostile, 0 neutral, 1 friendly; defaults to the actor's prototype token. */
  disposition?: number;
}

/**
 * Builds the data for a new scene token from an actor's prototype token, the
 * way FoundryVTT's own `Actor#getTokenDocument` does.
 */
export function buildTokenData(actorId: string, prototype: unknown, options: TokenOptions): Rec {
  const data = (isRec(prototype) ? structuredClone(prototype) : {}) as Rec;
  data._id = undefined;
  data.actorId = actorId;
  data.x = options.x;
  data.y = options.y;
  if (options.name) {
    data.name = options.name;
  }
  if (typeof options.hidden === 'boolean') {
    data.hidden = options.hidden;
  }
  if (typeof options.disposition === 'number') {
    data.disposition = options.disposition;
  }
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) {
      delete data[key];
    }
  }
  return data;
}
