/**
 * @fileoverview World / compendium browsing tools
 *
 * - get_compendium_document: read one full document (spell, monster, item, journal, table) from a pack
 * - get_roll_table: read (and optionally roll) a world or compendium roll table
 * - browse_world: list playlists, macros, tables, modules, folders or compendium packs
 *
 * All read-only. Compendium reads use the Socket.IO `modifyDocument` "get" action.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldActor, WorldData, WorldItem } from '../../foundry/types.js';
import { formatSheet } from './character.js';
import {
  at,
  buildSheet,
  htmlToText,
  isRec,
  itemSys,
  itemsOf,
  num,
  SCHOOLS,
  str,
  summarizeActivities,
  truncate,
} from './dnd5e.js';
import { folderPath } from './scenes.js';
import { pageSlice, withToolError } from './utils.js';

type Rec = Record<string, unknown>;

function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// get_compendium_document
// ---------------------------------------------------------------------------

function describeSpellOrItem(doc: Rec, type: string): string {
  const sys = isRec(doc.system) ? doc.system : {};
  const item = doc as unknown as WorldItem;
  const lines: string[] = [];
  const meta: string[] = [];
  if (type === 'spell') {
    const level = num(sys.level);
    meta.push(level === 0 ? 'Cantrip' : `Level ${level}`);
    meta.push(SCHOOLS[str(sys.school)] ?? str(sys.school));
    const props = Array.isArray(sys.properties) ? sys.properties.map(String) : [];
    const comps = [
      props.includes('vocal') ? 'V' : '',
      props.includes('somatic') ? 'S' : '',
      props.includes('material') ? 'M' : '',
    ].filter(Boolean);
    if (comps.length > 0) {
      meta.push(`components ${comps.join(',')}`);
    }
    if (props.includes('concentration')) {
      meta.push('concentration');
    }
    if (props.includes('ritual')) {
      meta.push('ritual');
    }
    const act = at(sys, 'activation');
    if (isRec(act) && act.type) {
      meta.push(`${act.value && num(act.value) > 1 ? `${act.value} ` : ''}${str(act.type)}`);
    }
    const range = at(sys, 'range');
    if (isRec(range) && (range.value || range.units)) {
      meta.push(`range ${range.value ? `${range.value} ` : ''}${str(range.units)}`);
    }
    const dur = at(sys, 'duration');
    if (isRec(dur) && (dur.value || dur.units)) {
      meta.push(`duration ${dur.value ? `${dur.value} ` : ''}${str(dur.units)}`);
    }
    const mat = str(at(sys, 'materials', 'value'));
    if (mat) {
      meta.push(`materials: ${mat}`);
    }
  } else {
    const t = str(at(sys, 'type', 'label')) || str(at(sys, 'type', 'value'));
    if (t) {
      meta.push(t);
    }
    const rarity = str(sys.rarity);
    if (rarity) {
      meta.push(rarity);
    }
    const price = at(sys, 'price');
    if (isRec(price) && price.value) {
      meta.push(`${price.value} ${str(price.denomination, 'gp')}`);
    }
    const weight = at(sys, 'weight', 'value');
    if (typeof weight === 'number' && weight > 0) {
      meta.push(`${weight} lb`);
    }
    if (sys.attunement === 'required' || sys.attunement === 'optional') {
      meta.push(`attunement ${str(sys.attunement)}`);
    }
  }
  if (meta.length > 0) {
    lines.push(meta.filter(Boolean).join(' · '));
  }
  const acts = summarizeActivities(item);
  if (acts) {
    lines.push(`Activities: ${acts}`);
  }
  const desc = htmlToText(at(sys, 'description', 'value'));
  if (desc) {
    lines.push('', truncate(desc, 3500));
  }
  return lines.join('\n');
}

function describeMonster(doc: Rec): string {
  const actor = doc as unknown as WorldActor;
  const sheet = buildSheet(actor);
  const head = formatSheet(actor, sheet, null, { compendium: true });
  const groups = new Map<string, string[]>();
  for (const item of itemsOf(actor)) {
    if (!['feat', 'weapon', 'spell'].includes(item.type)) {
      continue;
    }
    const key =
      item.type === 'spell' ? 'Spells' : item.type === 'weapon' ? 'Attacks' : 'Features & actions';
    const acts = summarizeActivities(item);
    const desc = truncate(
      htmlToText(at(itemSys(item), 'description', 'value')).replace(/\n+/g, ' '),
      320,
    );
    const entry = `- **${item.name}**${acts ? ` [${acts}]` : ''}${item.type !== 'spell' && desc ? `: ${desc}` : ''}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const bio = truncate(htmlToText(at(actor.system, 'details', 'biography', 'value')), 1200);
  const sections = [...groups.entries()].map(([k, v]) => `**${k}**\n${v.join('\n')}`);
  return [head, ...sections, bio ? `**Lore**\n${bio}` : ''].filter(Boolean).join('\n\n');
}

function describeJournal(doc: Rec): string {
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  return pages
    .filter(isRec)
    .map((p) => {
      const text = htmlToText(at(p, 'text', 'content'));
      return `### ${str(p.name)}\n${truncate(text, 3000) || `(no text — ${str(p.type)} page)`}`;
    })
    .join('\n\n');
}

/** A roll-table row as plain text (rows are often HTML with enrichers). */
export function rowText(r: Rec): string {
  return truncate(
    htmlToText(str(r.name) || str(r.description) || str(r.text)).replace(/\n+/g, ' '),
    400,
  );
}

function describeTable(doc: Rec): string {
  const results = Array.isArray(doc.results) ? doc.results.filter(isRec) : [];
  return `Formula ${str(doc.formula) || '?'} · ${results.length} results\n${results
    .map((r) => {
      const range = Array.isArray(r.range) ? r.range.join('–') : '?';
      return `- ${range}: ${rowText(r)}`;
    })
    .join('\n')}`;
}

/**
 * Resolves a compendium entry id from an explicit id or a name (exact match
 * first, then substring). Throws with the candidates when a name is ambiguous.
 */
export async function resolveEntryId(
  foundryClient: FoundryClient,
  compendiumId: string,
  documentId: string | undefined,
  name: string | undefined,
): Promise<string> {
  if (documentId) {
    return documentId;
  }
  if (!name) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide documentId or name');
  }
  const index = await foundryClient.getPackIndex(compendiumId);
  const lower = name.toLowerCase();
  const exact = index.filter((d) => str(d.name).toLowerCase() === lower);
  const partial = index.filter((d) => str(d.name).toLowerCase().includes(lower));
  const pool = exact.length > 0 ? exact : partial;
  if (pool.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `No entry named "${name}" in ${compendiumId}`);
  }
  if (pool.length > 1) {
    const list = pool
      .slice(0, 10)
      .map((d) => `${str(d.name)} (${str(d._id)})`)
      .join('; ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${name}" matches ${pool.length} entries — pass documentId: ${list}`,
    );
  }
  return str(pool[0]?._id);
}

export async function handleGetCompendiumDocument(
  args: { compendiumId?: string; documentId?: string; name?: string },
  foundryClient: FoundryClient,
) {
  const { compendiumId, documentId, name } = args;
  if (!compendiumId || typeof compendiumId !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'compendiumId is required (see foundry_compendium packs or search)',
    );
  }
  if (!documentId && !name) {
    throw new McpError(ErrorCode.InvalidParams, 'Provide documentId or name');
  }
  return withToolError('get compendium document', async () => {
    const id = await resolveEntryId(foundryClient, compendiumId, documentId, name);
    const doc = await foundryClient.getCompendiumDocument(compendiumId, id);
    const packType = str(foundryClient.listPacks().find((p) => p.id === compendiumId)?.type);
    const type = str(doc.type);

    let body: string;
    if (packType === 'Actor') {
      body = describeMonster(doc);
    } else if (packType === 'Item') {
      body = describeSpellOrItem(doc, type);
    } else if (packType === 'JournalEntry') {
      body = describeJournal(doc);
    } else if (packType === 'RollTable') {
      body = describeTable(doc);
    } else {
      body = `Document type ${packType || 'unknown'} — keys: ${Object.keys(doc).join(', ')}`;
    }

    return {
      content: [
        {
          type: 'text',
          text: `📖 **${str(doc.name)}** (${type || packType}) — \`${compendiumId}\` / \`${str(doc._id)}\`\n\n${body}`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// get_roll_table
// ---------------------------------------------------------------------------

/**
 * Rolls a plain dice formula locally: sums of `NdM`, `dM` and constants joined
 * by + or - (e.g. `1d20`, `d100`, `2d6+3`, `1d8+1d6-2`). Returns null for anything
 * else (keep/drop, exploding, pools, functions, references).
 */
export function rollFormula(formula: string): { total: number; detail: string } | null {
  const clean = formula.replace(/\s+/g, '');
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/i.test(clean)) {
    return null;
  }
  const terms = clean.match(/[+-]?(\d*d\d+|\d+)/gi) ?? [];
  let total = 0;
  let dice = 0;
  const parts: string[] = [];
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1;
    const body = term.replace(/^[+-]/, '');
    const m = body.match(/^(\d*)d(\d+)$/i);
    if (!m) {
      total += sign * Number(body);
      parts.push(`${sign < 0 ? '-' : '+'}${body}`);
      continue;
    }
    const n = m[1] ? Number(m[1]) : 1;
    const sides = Number(m[2]);
    dice += n;
    if (n < 1 || sides < 2 || dice > 100) {
      return null;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += 1 + Math.floor(Math.random() * sides);
    }
    total += sign * sum;
    parts.push(`${sign < 0 ? '-' : '+'}${sum}`);
  }
  if (dice === 0) {
    return null;
  }
  const rolls = parts.join('').replace(/^\+/, '');
  return { total, detail: `${clean} = ${rolls}` };
}

export async function handleGetRollTable(
  args: { table?: string; compendiumId?: string; roll?: boolean },
  foundryClient: FoundryClient,
) {
  const { table: ref, compendiumId, roll = false } = args;
  if (!ref || typeof ref !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'table (name or id) is required');
  }
  return withToolError('get roll table', async () => {
    const snapshot = snapshotOf(foundryClient);
    let doc: Rec | undefined;
    let source = 'world';
    const lower = ref.toLowerCase();
    if (!compendiumId) {
      const tables = snapshot.tables as Rec[];
      const matches = tables.filter(
        (t) =>
          t._id === ref ||
          str(t.name).toLowerCase() === lower ||
          str(t.name).toLowerCase().includes(lower),
      );
      if (matches.length > 1) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `"${ref}" matches ${matches.length} world tables: ${matches.map((t) => str(t.name)).join('; ')}`,
        );
      }
      doc = matches[0];
    }
    if (!doc) {
      if (!compendiumId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No world roll table matches "${ref}". Pass compendiumId (e.g. dnd5e.tables24) to look in a pack.`,
        );
      }
      const index = await foundryClient.getPackIndex(compendiumId);
      const hit =
        index.find((d) => d._id === ref) ??
        index.find((d) => str(d.name).toLowerCase() === lower) ??
        index.find((d) => str(d.name).toLowerCase().includes(lower));
      if (!hit) {
        throw new McpError(ErrorCode.InvalidParams, `No table "${ref}" in ${compendiumId}`);
      }
      doc = await foundryClient.getCompendiumDocument(compendiumId, str(hit._id));
      source = compendiumId;
    }

    const results = (Array.isArray(doc.results) ? doc.results : []).filter(isRec);
    let rolled = '';
    if (roll) {
      const r = rollFormula(str(doc.formula));
      if (r) {
        const hit = results.find(
          (x) => Array.isArray(x.range) && r.total >= num(x.range[0]) && r.total <= num(x.range[1]),
        );
        rolled = `\n\n🎲 **Rolled** ${r.detail} → **${r.total}**: ${hit ? rowText(hit) : 'no matching row'}\n_(local roll — not posted to Foundry chat)_`;
      } else {
        rolled = `\n\n_Could not roll formula "${str(doc.formula)}" locally._`;
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: `🎲 **${str(doc.name)}** (${source}) \`${str(doc._id)}\`\n${describeTable(doc)}${rolled}`,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// browse_world
// ---------------------------------------------------------------------------

const KINDS = ['playlists', 'macros', 'tables', 'modules', 'folders', 'packs'] as const;

export async function handleBrowseWorld(
  args: {
    kind?: string;
    query?: string;
    folder_type?: string;
    limit?: number;
    offset?: number;
  },
  foundryClient: FoundryClient,
) {
  const { kind, query, folder_type, limit = 60, offset } = args;
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    throw new McpError(ErrorCode.InvalidParams, `kind must be one of: ${KINDS.join(', ')}`);
  }
  return withToolError('browse world', async () => {
    const snapshot = snapshotOf(foundryClient);
    const q = (query ?? '').toLowerCase();
    let rows: string[] = [];

    if (kind === 'playlists') {
      rows = (snapshot.playlists as Rec[]).map((p) => {
        const sounds = (Array.isArray(p.sounds) ? p.sounds : [])
          .filter(isRec)
          .map((s) => str(s.name));
        return `- **${str(p.name)}** \`${str(p._id)}\` — ${sounds.length} tracks${p.playing === true ? ' · PLAYING' : ''}${sounds.length > 0 ? `: ${sounds.slice(0, 6).join(', ')}${sounds.length > 6 ? '…' : ''}` : ''}`;
      });
    } else if (kind === 'macros') {
      const users = new Map(snapshot.users.map((u) => [u._id, u.name]));
      rows = (snapshot.macros as Rec[]).map(
        (m) =>
          `- **${str(m.name)}** \`${str(m._id)}\` — ${str(m.type)}${users.get(str(m.author)) ? ` · by ${users.get(str(m.author))}` : ''}`,
      );
    } else if (kind === 'tables') {
      rows = (snapshot.tables as Rec[]).map(
        (t) =>
          `- **${str(t.name)}** \`${str(t._id)}\` — ${str(t.formula)} · ${Array.isArray(t.results) ? t.results.length : 0} results`,
      );
    } else if (kind === 'modules') {
      rows = (snapshot.modules as Rec[]).map(
        (m) =>
          `- **${str(m.title) || str(m.id)}** (\`${str(m.id)}\`) v${str(m.version)}${m.active === true ? ' · active' : m.active === false ? ' · inactive' : ''}`,
      );
    } else if (kind === 'folders') {
      const ft = folder_type?.toLowerCase();
      rows = (snapshot.folders as Rec[])
        .filter((f) => !ft || str(f.type).toLowerCase() === ft)
        .map((f) => `- ${folderPath(snapshot, str(f._id))} — ${str(f.type)} \`${str(f._id)}\``);
    } else {
      rows = foundryClient
        .listPacks()
        .map(
          (p) =>
            `- **${p.label}** \`${p.id}\` — ${p.type} · ${p.count ?? 'index not loaded'} entries · from ${p.packageName}`,
        );
    }

    const filtered = q ? rows.filter((r) => r.toLowerCase().includes(q)) : rows;
    const page = pageSlice(filtered, limit, offset);
    return {
      content: [
        {
          type: 'text',
          text: `📚 **${kind}** — ${filtered.length}${q ? ` matching "${query}"` : ''}\n\n${page.items.join('\n') || 'none'}${page.footer}`,
        },
      ],
    };
  });
}
