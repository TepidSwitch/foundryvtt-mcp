/**
 * @fileoverview Additive write tools: import from a compendium, place tokens
 *
 * Both tools only ever CREATE documents; nothing existing is modified. They
 * require FOUNDRY_WRITE_ENABLED=true and a GM login (enforced by the client).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { DISPOSITIONS, sceneSquares, squareToPixels } from '../../foundry/import.js';
import type { WorldData } from '../../foundry/types.js';
import { resolveActor } from './character.js';
import { at, isRec, num, str } from './dnd5e.js';
import { resolveScene } from './scenes.js';
import { withToolError } from './utils.js';
import { resolveEntryId } from './world-browse.js';

function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

const FOLDER_TYPES: Record<string, string> = {
  Actor: 'Actor',
  Item: 'Item',
  Scene: 'Scene',
  JournalEntry: 'JournalEntry',
  RollTable: 'RollTable',
};

/** Finds a world folder of the given document type by id or exact name. */
function resolveFolder(snapshot: WorldData, ref: string, packType: string): string {
  const type = FOLDER_TYPES[packType];
  const candidates = snapshot.folders.filter((f) => str(f.type) === type);
  const byId = candidates.find((f) => f._id === ref);
  if (byId) {
    return str(byId._id);
  }
  const named = candidates.filter((f) => str(f.name).toLowerCase() === ref.toLowerCase());
  if (named.length === 1 && named[0]) {
    return str(named[0]._id);
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    named.length > 1
      ? `"${ref}" matches ${named.length} ${type} folders — pass a folder id`
      : `No ${type} folder matches "${ref}". Folders are not created automatically; see foundry_world browse kind="folders" folder_type="${type}".`,
  );
}

// ---------------------------------------------------------------------------
// import_from_compendium
// ---------------------------------------------------------------------------

export async function handleImportFromCompendium(
  args: {
    compendiumId?: string;
    documentId?: string;
    name?: string;
    actor?: string;
    folder?: string;
    new_name?: string;
  },
  foundryClient: FoundryClient,
) {
  const { compendiumId, documentId, name, actor: actorRef, folder, new_name } = args;
  if (!compendiumId || typeof compendiumId !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'compendiumId is required (see foundry_compendium search or packs)',
    );
  }
  if (!documentId && !name) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide documentId or name');
  }
  return withToolError('import from compendium', async () => {
    const snapshot = snapshotOf(foundryClient);
    const pack = foundryClient.listPacks().find((p) => p.id === compendiumId);
    if (!pack) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown compendium pack: ${compendiumId}`);
    }
    if (!(pack.type in FOLDER_TYPES)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Importing ${pack.type} documents is not supported (supported: ${Object.keys(FOLDER_TYPES).join(', ')})`,
      );
    }
    if (actorRef && pack.type !== 'Item') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `actor can only be used with Item compendiums (this pack holds ${pack.type})`,
      );
    }
    if (actorRef && folder) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'folder does not apply when adding an item to an actor',
      );
    }

    const id = await resolveEntryId(foundryClient, compendiumId, documentId, name);
    const source = await foundryClient.getCompendiumDocument(compendiumId, id);
    const sourceName = str(source.name);

    let target: ReturnType<typeof resolveActor> | undefined;
    let folderId: string | undefined;
    if (actorRef) {
      target = resolveActor(foundryClient, actorRef);
    } else if (folder) {
      folderId = resolveFolder(snapshot, folder, pack.type);
    }

    // Importing twice makes two copies; say so rather than blocking.
    const wanted = new_name || sourceName;
    const existing = target
      ? (target.items ?? []).filter((i) => i.name === wanted)
      : (
          {
            Actor: snapshot.actors,
            Item: snapshot.items,
            Scene: snapshot.scenes,
            JournalEntry: snapshot.journal,
            RollTable: snapshot.tables as Array<{ name?: string }>,
          }[pack.type] ?? []
        ).filter((d) => (d as { name?: string }).name === wanted);

    const created = await foundryClient.importCompendiumDocument(compendiumId, id, {
      ...(new_name ? { name: new_name } : {}),
      ...(folderId ? { folder: folderId } : {}),
      ...(target ? { actorId: target._id } : {}),
    });

    const where = target
      ? `on **${target.name}** (\`${target._id}\`)`
      : `into the world${folderId ? ` (folder ${folder})` : ''}`;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Imported **${created.name}** (${created.type}) ${where}
New id: \`${created.id}\` · from \`${compendiumId}\` / \`${id}\`
${existing.length > 0 ? `\n⚠️ ${existing.length} document(s) named "${wanted}" already existed, so this is an additional copy.\n` : ''}
Nothing existing was modified. To undo, delete the new document in Foundry${target ? ' (or with foundry_items_edit remove_from_actor)' : ''}.`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// place_actor_on_scene
// ---------------------------------------------------------------------------

export async function handlePlaceActorOnScene(
  args: {
    scene?: string;
    actor?: string;
    x?: number;
    y?: number;
    count?: number;
    hidden?: boolean;
    disposition?: string;
    name?: string;
  },
  foundryClient: FoundryClient,
) {
  const { scene: sceneRef, actor: actorRef, x, y, count = 1, hidden, disposition, name } = args;
  if (!sceneRef || typeof sceneRef !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'scene (id or name) is required');
  }
  if (!actorRef || typeof actorRef !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'actor (id or name) is required');
  }
  if ((x === undefined) !== (y === undefined)) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide both x and y (grid squares), or neither');
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new McpError(ErrorCode.InvalidParams, 'count must be a whole number from 1 to 20');
  }
  if (disposition !== undefined && !(disposition in DISPOSITIONS)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `disposition must be one of: ${Object.keys(DISPOSITIONS).join(', ')}`,
    );
  }

  return withToolError('place actor on scene', async () => {
    const snapshot = snapshotOf(foundryClient);
    const scene = resolveScene(snapshot, sceneRef);
    const actor = resolveActor(foundryClient, actorRef);

    const geometry = {
      width: scene.width,
      height: scene.height,
      padding: scene.padding,
      gridSize: num(at(scene, 'grid', 'size'), 100) || 100,
      shiftX: num((scene as unknown as Record<string, unknown>).shiftX),
      shiftY: num((scene as unknown as Record<string, unknown>).shiftY),
    };
    const { cols, rows } = sceneSquares(geometry);
    const proto = isRec(actor.prototypeToken) ? actor.prototypeToken : {};
    const span = Math.max(1, Math.round(num(proto.width, 1)));

    const startCol = x ?? Math.floor(cols / 2);
    const startRow = y ?? Math.floor(rows / 2);
    if (!Number.isFinite(startCol) || !Number.isFinite(startRow)) {
      throw new McpError(ErrorCode.InvalidParams, 'x and y must be numbers');
    }

    // Lay tokens out left to right, wrapping to the next row at the map edge.
    const tokens: Array<{
      x: number;
      y: number;
      name?: string;
      hidden?: boolean;
      disposition?: number;
      label: string;
    }> = [];
    let col = Math.round(startCol);
    let row = Math.round(startRow);
    const base = name || actor.name;
    for (let i = 0; i < count; i++) {
      if (col + span > cols) {
        col = Math.round(startCol);
        row += span;
      }
      if (col < 0 || row < 0 || col + span > cols || row + span > rows) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Square (${col}, ${row}) is outside the ${cols}×${rows} map. Squares run from (0,0) at the top-left of the map image.`,
        );
      }
      const px = squareToPixels(geometry, col, row);
      tokens.push({
        x: px.x,
        y: px.y,
        ...(count > 1 || name ? { name: count > 1 ? `${base} ${i + 1}` : base } : {}),
        ...(typeof hidden === 'boolean' ? { hidden } : {}),
        ...(disposition ? { disposition: DISPOSITIONS[disposition] as number } : {}),
        label: `(${col}, ${row})`,
      });
      col += span;
    }

    const placed = await foundryClient.createSceneTokens(
      scene._id,
      actor._id,
      tokens.map(({ label: _label, ...t }) => t),
    );

    const visible = scene.active && hidden !== true;
    return {
      content: [
        {
          type: 'text',
          text: `✅ Placed ${placed.length} token${placed.length === 1 ? '' : 's'} of **${actor.name}** on **${scene.name}** (\`${scene._id}\`)
${placed.map((p, i) => `- ${p.name || actor.name} \`${p.id}\` at square ${tokens[i]?.label}`).join('\n')}
${visible ? '\n⚠️ This scene is active and the tokens are not hidden, so players can see them now.\n' : ''}
Map is ${cols}×${rows} squares; squares are counted from the top-left of the map image. Nothing existing was modified. Remove tokens in Foundry if unwanted.`,
        },
      ],
    };
  });
}
