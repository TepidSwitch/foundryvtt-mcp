/**
 * @fileoverview Scene tools
 *
 * - get_scene_info: full detail for one scene (by id, name, or the active scene)
 * - search_scenes: list/filter every scene with folder, size and content counts
 * - suggest_scenes: rank scenes by how "ready to run" they are, optionally by theme
 * - get_scene_image: return the scene map as an image so it can actually be looked at
 *
 * Readiness is a heuristic over stored metadata (walls, lights, pre-placed
 * tokens, map notes, linked journal/playlist). It cannot judge how a map looks;
 * use get_scene_image for that.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import { sceneOrigin } from '../../foundry/import.js';
import type { WorldData, WorldScene } from '../../foundry/types.js';
import { at, isRec, num, str } from './dnd5e.js';
import { withToolError } from './utils.js';

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

/** "Root / Child" folder path for a folder id ('' when unfiled). */
export function folderPath(snapshot: WorldData, folderId: string | null | undefined): string {
  const byId = new Map(snapshot.folders.map((f) => [str(f._id), f]));
  const parts: string[] = [];
  let cur = folderId ? byId.get(folderId) : undefined;
  let guard = 0;
  while (cur && guard++ < 12) {
    parts.unshift(str(cur.name));
    const parent = cur.folder;
    cur = typeof parent === 'string' ? byId.get(parent) : undefined;
  }
  return parts.join(' / ');
}

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export function resolveScene(snapshot: WorldData, ref: string): WorldScene {
  const q = ref.trim();
  const byId = snapshot.scenes.find((s) => s._id === q);
  if (byId) {
    return byId;
  }
  const lower = q.toLowerCase();
  const exact = snapshot.scenes.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length === 1 && exact[0]) {
    return exact[0];
  }
  const partial = snapshot.scenes.filter((s) => s.name.toLowerCase().includes(lower));
  if (partial.length === 1 && partial[0]) {
    return partial[0];
  }
  if (partial.length + exact.length > 1) {
    const list = (exact.length > 0 ? exact : partial)
      .slice(0, 8)
      .map((s) => `${s.name} (${s._id})`)
      .join('; ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${ref}" matches several scenes — be more specific or use an id: ${list}`,
    );
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `No scene matches "${ref}". Try foundry_scenes search.`,
  );
}

interface SceneFacts {
  scene: WorldScene;
  path: string;
  gridSize: number;
  cols: number;
  rows: number;
  tokens: number;
  hostile: number;
  walls: number;
  lights: number;
  notes: number;
  tiles: number;
  regions: number;
  sounds: number;
  hasJournal: boolean;
  hasPlaylist: boolean;
  tags: string[];
}

// Keyword → tag. Matched against scene name + folder path.
const TAG_KEYWORDS: Array<[string, string[]]> = [
  [
    'social',
    [
      'tavern',
      'inn',
      'shop',
      'bar',
      'bakery',
      'spa',
      'market',
      'bathhouse',
      'guildhall',
      'theatre',
      'theater',
      'social',
      'festival',
      'carnival',
      'circus',
      'big top',
      'cathedral',
      'mansion',
      'manor',
    ],
  ],
  [
    'dungeon',
    [
      'temple',
      'tomb',
      'crypt',
      'lair',
      'cave',
      'cavern',
      'ruins',
      'dungeon',
      'vault',
      'gaol',
      'jail',
      'prison',
      'lab',
      'catacomb',
      'pyramid',
      'shrine',
      'mind-feaster',
      'pit',
      'basilica',
      'sanctuary',
      'underground',
      'roots',
      'worm',
      'meat locker',
    ],
  ],
  [
    'wilderness',
    [
      'forest',
      'grove',
      'swamp',
      'river',
      'jungle',
      'valley',
      'camp',
      'patch',
      'desert',
      'mountain',
      'chasm',
      'glade',
      'fireflies',
      'overwatch',
      'encounter',
      'traveling',
      'shelf',
      'dam',
    ],
  ],
  [
    'urban',
    [
      'city',
      'town',
      'street',
      'roads',
      'gates',
      'guild',
      'district',
      'plaza',
      'square',
      'harbor',
      'alley',
      'village',
      'fortress',
      'castle',
    ],
  ],
  [
    'nautical',
    ['ship', 'pirate', 'dock', 'harbor', 'sea', 'ocean', 'whirlpool', 'coral', 'drowned', 'boat'],
  ],
  [
    'set-piece',
    [
      'bridge',
      'rail',
      'train',
      'chasm',
      'coliseum',
      'arena',
      'pit',
      'engine',
      'reactor',
      'summoning',
      'singularity',
      'heist',
      'lair',
    ],
  ],
];

export function tagsFor(name: string, path: string): string[] {
  const hay = `${name} ${path}`.toLowerCase();
  return TAG_KEYWORDS.filter(([, words]) => words.some((w) => hay.includes(w))).map(([tag]) => tag);
}

/** Canvas pixels to "col,row" grid squares from the map image's top-left corner. */
function mapSquare(
  x: number,
  y: number,
  origin: { x: number; y: number },
  gridSize: number,
): string {
  const square = (v: number) => String(Math.round((v / gridSize) * 10) / 10);
  return `${square(x - origin.x)},${square(y - origin.y)}`;
}

function factsFor(snapshot: WorldData, scene: WorldScene): SceneFacts {
  const gridSize = num(at(scene, 'grid', 'size'), 100) || 100;
  const tokens = Array.isArray(scene.tokens) ? scene.tokens : [];
  const path = folderPath(snapshot, scene.folder);
  return {
    scene,
    path,
    gridSize,
    cols: Math.round(scene.width / gridSize),
    rows: Math.round(scene.height / gridSize),
    tokens: tokens.length,
    hostile: tokens.filter((t) => num(t.disposition) < 0).length,
    walls: count(scene.walls),
    lights: count(scene.lights),
    notes: count(scene.notes),
    tiles: count(scene.tiles),
    regions: count((scene as unknown as Rec).regions),
    sounds: count(scene.sounds),
    hasJournal: Boolean((scene as unknown as Rec).journal),
    hasPlaylist: Boolean((scene as unknown as Rec).playlist),
    tags: tagsFor(scene.name, path),
  };
}

/** 0–100 "how much of the prep work is already done" plus the reasons. */
export function readiness(f: SceneFacts): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (f.walls >= 30) {
    score += 25;
    reasons.push(`walled (${f.walls} walls)`);
  } else if (f.walls > 0) {
    score += 12;
    reasons.push(`some walls (${f.walls})`);
  }
  if (f.lights >= 8) {
    score += 20;
    reasons.push(`lit (${f.lights} lights)`);
  } else if (f.lights > 0) {
    score += 10;
    reasons.push(`some lighting (${f.lights})`);
  }
  if (f.tokens > 0) {
    score += 15;
    reasons.push(
      `pre-populated (${f.tokens} tokens${f.hostile > 0 ? `, ${f.hostile} hostile` : ''})`,
    );
  }
  if (f.notes > 0) {
    score += 10;
    reasons.push(`keyed map notes (${f.notes})`);
  }
  if (f.hasJournal) {
    score += 10;
    reasons.push('linked journal');
  }
  if (f.hasPlaylist || f.sounds > 0) {
    score += 5;
    reasons.push('has audio');
  }
  if (f.tiles > 0 || f.regions > 0) {
    score += 5;
    reasons.push('tiles/regions (scripted areas)');
  }
  const long = Math.max(f.cols, f.rows);
  const short = Math.min(f.cols, f.rows);
  if (short >= 15 && long <= 70) {
    score += 10;
    reasons.push(`playable size (${f.cols}×${f.rows})`);
  }
  return { score: Math.min(score, 100), reasons };
}

function band(score: number): string {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function line(f: SceneFacts): string {
  return `**${f.scene.name}** \`${f.scene._id}\`${f.path ? ` — ${f.path}` : ''} · ${f.cols}×${f.rows} squares · ${f.walls} walls, ${f.lights} lights, ${f.tokens} tokens, ${f.notes} notes${f.scene.active ? ' · ACTIVE' : ''}${f.tags.length > 0 ? ` · ${f.tags.join('/')}` : ''}`;
}

// ---------------------------------------------------------------------------
// get_scene_info
// ---------------------------------------------------------------------------

export async function handleGetSceneInfo(
  args: { sceneId?: string; name?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('get scene info', async () => {
    const snapshot = snapshotOf(foundryClient);
    const ref = args.sceneId ?? args.name;
    const scene = ref ? resolveScene(snapshot, ref) : snapshot.scenes.find((s) => s.active);
    if (!scene) {
      throw new McpError(ErrorCode.InvalidParams, 'No active scene — pass sceneId or name');
    }
    const f = factsFor(snapshot, scene);
    const env = at(scene, 'environment');
    const darkness = num(at(env, 'darknessLevel'), scene.darkness ?? 0);
    const globalLight = at(env, 'globalLight', 'enabled') === true || scene.globalLight === true;

    const tokens = Array.isArray(scene.tokens) ? scene.tokens : [];
    const disp: Record<number, string> = {
      [-1]: 'hostile',
      0: 'neutral',
      1: 'friendly',
      [-2]: 'secret',
    };
    const raw = scene as unknown as Record<string, unknown>;
    const origin = sceneOrigin({
      width: scene.width,
      height: scene.height,
      padding: scene.padding,
      gridSize: f.gridSize,
      shiftX: num(raw.shiftX),
      shiftY: num(raw.shiftY),
    });
    const tokenLines = tokens
      .slice(0, 40)
      .map(
        (t) =>
          `- ${str(t.name) || 'Unnamed'} \`${str(t._id)}\` (${disp[num(t.disposition)] ?? 'unknown'}${t.hidden === true ? ', hidden' : ''}${t.actorLink === true ? ', linked' : ''}) at ${mapSquare(num(t.x), num(t.y), origin, f.gridSize)} (canvas ${Math.round(num(t.x))},${Math.round(num(t.y))} px)`,
      );
    const notes = (Array.isArray(scene.notes) ? scene.notes : []).slice(0, 30).map((n) => {
      const entry = snapshot.journal.find((j) => j._id === n.entryId);
      return `- ${str(n.text) || '(no label)'} \`${str(n._id)}\`${entry ? ` → journal "${entry.name}"` : ''}`;
    });
    const lights = (Array.isArray(scene.lights) ? scene.lights : []).slice(0, 30).map((l) => {
      const cfg = at(l, 'config');
      return `- ${str((l as Rec).name) || 'light'} \`${str((l as Rec)._id)}\` bright ${num(at(cfg, 'bright'))}, dim ${num(at(cfg, 'dim'))}`;
    });

    const journalId = str((scene as unknown as Rec).journal);
    const journal = journalId ? snapshot.journal.find((j) => j._id === journalId) : undefined;
    const playlistId = str((scene as unknown as Rec).playlist);
    const playlist = playlistId ? snapshot.playlists.find((p) => p._id === playlistId) : undefined;
    const weather = str((scene as unknown as Rec).weather);
    const r = readiness(f);

    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **${scene.name}** \`${scene._id}\`${
            ref
              ? ''
              : '\n_No sceneId or name was given, so this is the active scene. Pass sceneId for another one (see foundry_scenes search)._'
          }
**Folder:** ${f.path || 'none'} · **Active:** ${scene.active ? 'Yes' : 'No'} · **In navigation bar:** ${scene.navigation ? 'Yes' : 'No'}
**Size:** ${f.cols}×${f.rows} squares (${scene.width}×${scene.height}px, ${f.gridSize}px grid, ${num(at(scene, 'grid', 'distance'), 5)} ${str(at(scene, 'grid', 'units'), 'ft')}/square)
**Lighting:** darkness ${Math.round(darkness * 100)}%, global light ${globalLight ? 'on' : 'off'}${weather ? `, weather: ${weather}` : ''}
**Content:** ${f.walls} walls · ${f.lights} lights · ${f.tokens} tokens · ${f.notes} notes · ${f.tiles} tiles · ${f.regions} regions · ${f.sounds} sounds
**Journal:** ${journal ? journal.name : 'none'} · **Playlist:** ${playlist ? str(playlist.name) : 'none'}
**Map origin:** canvas ${origin.x},${origin.y} px (scene padding and shift)
**Tags (from name/folder):** ${f.tags.join(', ') || 'none'}
**Readiness:** ${r.score}/100 (${band(r.score)}) — ${r.reasons.join(', ') || 'bare map'}

**Tokens** (${tokens.length}) — positions are grid squares from the top-left of the map image (scene padding removed); canvas px is what foundry_tokens_edit move takes
${tokenLines.join('\n') || 'none'}${tokens.length > 40 ? `\n…and ${tokens.length - 40} more` : ''}

**Map notes** (${f.notes})
${notes.join('\n') || 'none'}

**Lights** (${f.lights})
${lights.join('\n') || 'none'}

_Use foundry_scenes image to see the map itself._`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// search_scenes
// ---------------------------------------------------------------------------

export async function handleSearchScenes(
  args: {
    query?: string;
    folder?: string;
    active_only?: boolean;
    min_tokens?: number;
    has_walls?: boolean;
    has_lights?: boolean;
    has_notes?: boolean;
    limit?: number;
  },
  foundryClient: FoundryClient,
) {
  const {
    query,
    folder,
    active_only,
    min_tokens,
    has_walls,
    has_lights,
    has_notes,
    limit = 25,
  } = args;
  return withToolError('search scenes', async () => {
    const snapshot = snapshotOf(foundryClient);
    let facts = snapshot.scenes.map((s) => factsFor(snapshot, s));
    if (query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      facts = facts.filter((f) => {
        const hay = `${f.scene.name} ${f.path} ${f.tags.join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (folder) {
      const fl = folder.toLowerCase();
      facts = facts.filter((f) => f.path.toLowerCase().includes(fl));
    }
    if (active_only) {
      facts = facts.filter((f) => f.scene.active);
    }
    if (typeof min_tokens === 'number') {
      facts = facts.filter((f) => f.tokens >= min_tokens);
    }
    if (has_walls) {
      facts = facts.filter((f) => f.walls > 0);
    }
    if (has_lights) {
      facts = facts.filter((f) => f.lights > 0);
    }
    if (has_notes) {
      facts = facts.filter((f) => f.notes > 0);
    }

    const shown = facts.slice(0, limit);
    return {
      content: [
        {
          type: 'text',
          text: `🗺️ **Scenes** — ${facts.length} of ${snapshot.scenes.length} match${facts.length > shown.length ? ` (showing ${shown.length})` : ''}

${shown.map((f) => `- ${line(f)}`).join('\n') || 'No scenes matched.'}

_Use foundry_scenes get for tokens and notes, suggest to rank by adventure-readiness, image to see the map._`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// suggest_scenes
// ---------------------------------------------------------------------------

const PURPOSES = ['combat', 'exploration', 'social', 'any'] as const;

function purposeBonus(f: SceneFacts, purpose: string): number {
  const long = Math.max(f.cols, f.rows);
  switch (purpose) {
    case 'combat':
      return (
        (f.tags.includes('set-piece') || f.tags.includes('dungeon') || f.tags.includes('wilderness')
          ? 10
          : 0) + (f.tokens > 0 ? 5 : 0)
      );
    case 'social':
      return f.tags.includes('social') || f.tags.includes('urban') ? 15 : 0;
    case 'exploration':
      return (
        (long >= 40 ? 10 : 0) +
        (f.tags.includes('dungeon') || f.tags.includes('wilderness') ? 5 : 0) +
        (f.notes > 0 ? 5 : 0)
      );
    default:
      return 0;
  }
}

export async function handleSuggestScenes(
  args: {
    theme?: string;
    purpose?: string;
    min_readiness?: number;
    limit?: number;
    include_compendium?: boolean;
  },
  foundryClient: FoundryClient,
) {
  const {
    theme,
    purpose = 'any',
    min_readiness = 0,
    limit = 10,
    include_compendium = false,
  } = args;
  if (!(PURPOSES as readonly string[]).includes(purpose)) {
    throw new McpError(ErrorCode.InvalidParams, `purpose must be one of: ${PURPOSES.join(', ')}`);
  }
  return withToolError('suggest scenes', async () => {
    const snapshot = snapshotOf(foundryClient);
    const words = (theme ?? '')
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);

    const ranked = snapshot.scenes
      .map((s) => {
        const f = factsFor(snapshot, s);
        const hay = `${s.name} ${f.path} ${f.tags.join(' ')}`.toLowerCase();
        const matched = words.filter((w) => hay.includes(w));
        const r = readiness(f);
        return { f, r, matched, total: r.score + purposeBonus(f, purpose) + matched.length * 8 };
      })
      .filter((x) => (words.length === 0 || x.matched.length > 0) && x.r.score >= min_readiness)
      .sort((a, b) => b.total - a.total || a.f.scene.name.localeCompare(b.f.scene.name));

    const top = ranked.slice(0, limit);
    const body = top
      .map((x, i) => {
        const hostiles = (Array.isArray(x.f.scene.tokens) ? x.f.scene.tokens : [])
          .filter((t) => num(t.disposition) < 0)
          .map((t) => str(t.name))
          .filter(Boolean);
        const uniq = [...new Set(hostiles)].slice(0, 6);
        return `${i + 1}. ${line(x.f)}\n   readiness ${x.r.score}/100 (${band(x.r.score)}): ${x.r.reasons.join(', ') || 'bare map'}${uniq.length > 0 ? `\n   hostiles: ${uniq.join(', ')}` : ''}`;
      })
      .join('\n');

    let compendiumBlock = '';
    if (include_compendium && words.length > 0) {
      const hits: string[] = [];
      const worldNames = new Set(snapshot.scenes.map((s) => s.name.toLowerCase()));
      for (const pack of snapshot.packs) {
        if (String(pack.type) !== 'Scene') {
          continue;
        }
        const index = await foundryClient.getPackIndex(String(pack.id));
        for (const doc of index) {
          const name = String(doc.name ?? '');
          // Skip maps that were already imported into the world.
          if (worldNames.has(name.toLowerCase())) {
            continue;
          }
          if (words.some((w) => name.toLowerCase().includes(w))) {
            hits.push(
              `- ${name} — ${String(pack.label ?? pack.id)} (\`${String(pack.id)}\` / \`${String(doc._id)}\`)`,
            );
          }
        }
      }
      compendiumBlock = `\n\n**Not yet imported — matching maps in compendium packs** (${hits.length}${hits.length > 15 ? ', first 15' : ''})\n${hits.slice(0, 15).join('\n') || 'none'}`;
    }

    return {
      content: [
        {
          type: 'text',
          text: `🧭 **Suggested scenes** — ${ranked.length} candidates${theme ? ` for "${theme}"` : ''}${purpose !== 'any' ? `, purpose: ${purpose}` : ''}

${body || 'No scenes matched. Try a broader theme or lower min_readiness.'}${compendiumBlock}

_Readiness scores how much prep is already done (walls, lights, tokens, notes, journal, audio, size). It does not judge how a map looks — call foundry_scenes image on a candidate to check._`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// get_scene_image
// ---------------------------------------------------------------------------

const THUMB_MAX_BYTES = 1_000_000;
const FULL_MAX_BYTES = 1_500_000;

/** Foundry paths may be stored percent-encoded already or with raw spaces. */
function normalizePath(p: string): string {
  try {
    return encodeURI(decodeURI(p));
  } catch {
    return p;
  }
}

export async function handleGetSceneImage(
  args: { scene?: string; full?: boolean },
  foundryClient: FoundryClient,
) {
  const { scene: ref, full = false } = args;
  if (!ref || typeof ref !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'scene (id or name) is required');
  }
  return withToolError('get scene image', async () => {
    const snapshot = snapshotOf(foundryClient);
    const scene = resolveScene(snapshot, ref);
    const levels = (scene as unknown as Rec).levels;
    const level0 = Array.isArray(levels) && isRec(levels[0]) ? levels[0] : undefined;
    const backgroundSrc =
      str(at(level0, 'background', 'src')) || str(at(scene, 'background', 'src')) || str(scene.img);
    const thumb = str((scene as unknown as Rec).thumb);

    let source = '';
    let note = '';
    if (full && backgroundSrc) {
      source = backgroundSrc;
    } else if (thumb) {
      source = thumb;
      note = full
        ? ' (no full-size background found; showing thumbnail)'
        : ' (thumbnail — pass full=true for the full map)';
    } else if (backgroundSrc) {
      source = backgroundSrc;
    }
    if (!source) {
      throw new McpError(ErrorCode.InvalidParams, `Scene "${scene.name}" has no image`);
    }

    let asset: { data: Buffer; mimeType: string };
    try {
      asset = await foundryClient.fetchAsset(
        normalizePath(source),
        full ? FULL_MAX_BYTES : THUMB_MAX_BYTES,
      );
    } catch (error) {
      if (full && thumb) {
        asset = await foundryClient.fetchAsset(normalizePath(thumb), THUMB_MAX_BYTES);
        note = ' (full map too large to return; showing thumbnail)';
      } else {
        throw error;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `🖼️ **${scene.name}** \`${scene._id}\`${note}`,
        },
        {
          type: 'image',
          data: asset.data.toString('base64'),
          mimeType: asset.mimeType,
        },
      ],
    };
  });
}
