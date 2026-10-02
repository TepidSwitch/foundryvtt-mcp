/**
 * @fileoverview write_session_notes — turn a markdown recap into a journal entry.
 *
 * WRITE operation (creates one new JournalEntry). The markdown is converted to
 * HTML and names of world actors, scenes and journals that appear in the text
 * are turned into Foundry `@UUID[...]` links, so the recap is clickable in-game.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { DocumentVisibility } from '../../foundry/types.js';
import { VISIBILITY_LEVELS } from '../../foundry/types.js';
import { withToolError } from './utils.js';

export interface LinkTarget {
  /** Foundry document type, e.g. "Actor". */
  type: 'Actor' | 'Scene' | 'JournalEntry';
  id: string;
  name: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal markdown: #/##/### headings, -/* bullets, 1. lists, paragraphs. */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = (heading[1] as string).length + 1; // page title already is h1
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet?.[1] ?? numbered?.[1]) as string)}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('\n');
}

/**
 * Replaces entity names in HTML text (never inside tags) with @UUID links.
 * One pass over a longest-first alternation, so nothing is linked twice.
 */
export function linkEntities(
  html: string,
  targets: LinkTarget[],
): { html: string; linked: LinkTarget[] } {
  const usable = targets.filter((t) => t.name.trim().length >= 4);
  if (usable.length === 0) {
    return { html, linked: [] };
  }
  const byName = new Map<string, LinkTarget>();
  for (const t of usable) {
    // Actors win over scenes/journals with the same name.
    if (!byName.has(t.name)) {
      byName.set(t.name, t);
    }
  }
  const escaped = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\w@])(${escaped.join('|')})(?![\\w])`, 'g');
  const linked = new Map<string, LinkTarget>();

  const result = html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        return part;
      }
      return part.replace(pattern, (match) => {
        const plain = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const target = byName.get(plain);
        if (!target) {
          return match;
        }
        linked.set(target.id, target);
        return `@UUID[${target.type}.${target.id}]{${match}}`;
      });
    })
    .join('');
  return { html: result, linked: [...linked.values()] };
}

function collectTargets(foundryClient: FoundryClient): LinkTarget[] {
  const world = foundryClient.getWorldData();
  if (!world) {
    return [];
  }
  return [
    ...world.actors.map((a) => ({ type: 'Actor' as const, id: a._id, name: a.name })),
    ...world.scenes.map((s) => ({ type: 'Scene' as const, id: s._id, name: s.name })),
    ...world.journal.map((j) => ({ type: 'JournalEntry' as const, id: j._id, name: j.name })),
  ];
}

export async function handleWriteSessionNotes(
  args: {
    title: string;
    notes: string;
    folder?: string;
    visibility?: DocumentVisibility;
    link_entities?: boolean;
    split_by_heading?: boolean;
  },
  foundryClient: FoundryClient,
) {
  const { title, notes, folder, visibility } = args;
  if (!title || typeof title !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'title is required and must be a string');
  }
  if (!notes || typeof notes !== 'string' || !notes.trim()) {
    throw new McpError(ErrorCode.InvalidParams, 'notes is required and must be non-empty markdown');
  }
  if (visibility !== undefined && !(visibility in VISIBILITY_LEVELS)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `visibility must be one of: ${Object.keys(VISIBILITY_LEVELS).join(', ')}`,
    );
  }

  return withToolError('write session notes', async () => {
    const wantLinks = args.link_entities !== false;
    const targets = wantLinks ? collectTargets(foundryClient) : [];

    // Optionally split on "## " sections into separate pages.
    const sections: Array<{ name: string; md: string }> = [];
    if (args.split_by_heading) {
      let current = { name: title, md: '' };
      for (const line of notes.replace(/\r\n/g, '\n').split('\n')) {
        const h2 = /^##\s+(.*)$/.exec(line);
        if (h2) {
          if (current.md.trim()) {
            sections.push(current);
          }
          current = { name: h2[1] as string, md: '' };
        } else {
          current.md += `${line}\n`;
        }
      }
      if (current.md.trim()) {
        sections.push(current);
      }
    }
    if (sections.length === 0) {
      sections.push({ name: title, md: notes });
    }

    const allLinked = new Map<string, LinkTarget>();
    const pages = sections.map((s) => {
      const { html, linked } = linkEntities(markdownToHtml(s.md), targets);
      for (const t of linked) {
        allLinked.set(t.id, t);
      }
      return { name: s.name, content: html };
    });

    const journal = await foundryClient.createJournalEntry(title, pages, folder, visibility);
    const linkedList = [...allLinked.values()].map((t) => `${t.name} (${t.type})`);
    return {
      content: [
        {
          type: 'text',
          text: `📓 **Session notes saved**
**Journal:** ${journal.name} · id \`${journal._id}\`
**Pages:** ${pages.length}
**Visible to:** ${visibility ? visibility : 'GM only'}
**Linked in text:** ${linkedList.length ? linkedList.join(', ') : wantLinks ? 'no known names found' : 'linking off'}

Only a new journal entry was created. To undo, delete it in Foundry.`,
        },
      ],
    };
  });
}
