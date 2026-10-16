/**
 * @fileoverview Tests for the tool registry and the domain-tool surface
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import type { ToolContext } from '../base.js';
import { DomainTool } from '../domain.js';
import { ALL_DOMAIN_TOOLS } from '../domains/index.js';
import { createToolRegistry } from '../index.js';
import { DEFAULT_TOOLSETS, parseToolsets } from '../registry.js';

/** name, readOnlyHint, destructiveHint — the published tool surface. */
const EXPECTED_SURFACE: Array<[string, boolean, boolean]> = [
  ['foundry_actors', true, false],
  ['foundry_actors_edit', false, true],
  ['foundry_items', true, false],
  ['foundry_items_edit', false, true],
  ['foundry_effects_edit', false, true],
  ['foundry_scenes', true, false],
  ['foundry_scenes_edit', false, true],
  ['foundry_tokens_edit', false, true],
  ['foundry_combat', true, false],
  ['foundry_combat_edit', false, true],
  ['foundry_journals', true, false],
  ['foundry_journals_edit', false, true],
  ['foundry_compendium', true, false],
  ['foundry_audio', true, false],
  ['foundry_audio_edit', false, true],
  ['foundry_chat', true, false],
  ['foundry_chat_edit', false, false],
  ['foundry_world', true, false],
  ['foundry_world_edit', false, true],
  ['foundry_files', true, false],
  ['foundry_files_edit', false, false],
  ['foundry_generate', true, false],
  ['foundry_history', true, false],
  ['foundry_history_edit', false, true],
  ['foundry_diagnostics', true, false],
];

const ACTIONS: Record<string, string[]> = {
  foundry_actors: ['search', 'get', 'items', 'party', 'find_in_party', 'compare'],
  foundry_actors_edit: ['update', 'set_ownership', 'import'],
  foundry_items: ['search'],
  foundry_items_edit: [
    'create',
    'update',
    'delete',
    'use',
    'add_to_actor',
    'update_on_actor',
    'remove_from_actor',
  ],
  foundry_effects_edit: ['list', 'create', 'update', 'delete', 'remove_status', 'apply_status'],
  foundry_scenes: ['search', 'get', 'suggest', 'image'],
  foundry_scenes_edit: [
    'activate',
    'update',
    'add_note',
    'remove_note',
    'add_light',
    'remove_light',
  ],
  foundry_tokens_edit: ['place', 'update', 'delete', 'move'],
  foundry_combat: ['state'],
  foundry_combat_edit: ['start', 'next_turn', 'set_initiative', 'end'],
  foundry_journals: ['search', 'get'],
  foundry_journals_edit: [
    'create',
    'add_page',
    'append',
    'replace_page',
    'rename',
    'delete',
    'write_session_notes',
  ],
  foundry_compendium: ['search', 'get', 'packs', 'roll_table'],
  foundry_audio: ['list'],
  foundry_audio_edit: [
    'play',
    'stop',
    'create_playlist',
    'add_sound',
    'update',
    'delete',
    'set_scene_music',
  ],
  foundry_chat: ['read', 'roll'],
  foundry_chat_edit: ['send', 'request_roll', 'draw_table'],
  foundry_world: ['summary', 'search', 'browse', 'users', 'refresh'],
  foundry_world_edit: ['create_folder', 'move_to_folder'],
  foundry_files: ['browse'],
  foundry_files_edit: ['mkdir', 'upload'],
  foundry_generate: ['npc', 'loot', 'rule'],
  foundry_history: ['log'],
  foundry_history_edit: ['undo'],
  foundry_diagnostics: ['health', 'system', 'search_logs', 'logs', 'diagnose'],
};

function context(client: Partial<FoundryClient> = {}): ToolContext {
  return { foundryClient: client as unknown as FoundryClient };
}

describe('tool surface', () => {
  const registry = createToolRegistry({ writeEnabled: true });

  it('publishes exactly the planned tools with accurate annotations', () => {
    const actual = registry
      .getToolDefinitions()
      .map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint]);
    expect(actual).toEqual(EXPECTED_SURFACE);
  });

  it('lists the planned actions for every tool', () => {
    for (const tool of ALL_DOMAIN_TOOLS) {
      expect(tool).toBeInstanceOf(DomainTool);
      expect((tool as DomainTool).getActionNames(), tool.name).toEqual(ACTIONS[tool.name]);
    }
  });

  it('has a handler and a schema for every action of every tool', () => {
    for (const tool of ALL_DOMAIN_TOOLS as DomainTool[]) {
      for (const name of tool.getActionNames()) {
        const def = tool.getAction(name);
        expect(typeof def?.run, `${tool.name}.${name} run`).toBe('function');
        expect(def?.schema, `${tool.name}.${name} schema`).toBeDefined();
        expect(def?.description.length, `${tool.name}.${name} description`).toBeGreaterThan(10);
      }
    }
  });

  it('publishes an object schema whose action enum matches the actions', () => {
    for (const def of registry.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
      const props = def.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.action?.enum, def.name).toEqual(ACTIONS[def.name]);
      expect(def.inputSchema.required).toEqual(['action']);
    }
  });

  it('describes each action and its fields in the tool description', () => {
    const chat = registry.getToolDefinitions().find((t) => t.name === 'foundry_chat');
    expect(chat?.description).toContain('- read (limit?)');
    expect(chat?.description).toContain('- roll (formula, reason?)');
  });
});

describe('registry filtering', () => {
  it('hides write tools unless writes are enabled', () => {
    const names = createToolRegistry({ writeEnabled: false }).getToolNames();
    expect(names).toHaveLength(13);
    expect(names.some((n) => n.endsWith('_edit'))).toBe(false);
  });

  it('refuses to execute a hidden write tool and says how to enable it', async () => {
    const registry = createToolRegistry({ writeEnabled: false });
    expect(registry.has('foundry_actors_edit')).toBe(false);
    await expect(
      registry.execute('foundry_actors_edit', { action: 'update' }, context()),
    ).rejects.toThrow(/FOUNDRY_WRITE_ENABLED=true/);
  });

  it('filters by toolset', () => {
    const registry = createToolRegistry({ writeEnabled: true, toolsets: ['chat', 'combat'] });
    expect(registry.getToolNames()).toEqual([
      'foundry_combat',
      'foundry_combat_edit',
      'foundry_chat',
      'foundry_chat_edit',
    ]);
  });

  it('rejects unknown tools', async () => {
    const registry = createToolRegistry({ writeEnabled: true });
    await expect(registry.execute('roll_dice', {}, context())).rejects.toThrow(/Unknown tool/);
  });

  it('parses FOUNDRY_TOOLSETS, defaulting to everything except script', () => {
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(DEFAULT_TOOLSETS).not.toContain('script');
    const unknown: string[] = [];
    expect(parseToolsets(' Chat, combat ,bogus', (n) => unknown.push(n))).toEqual([
      'chat',
      'combat',
    ]);
    expect(unknown).toEqual(['bogus']);
  });
});

describe('execution', () => {
  const registry = createToolRegistry({ writeEnabled: true });

  it('routes an action to its handler', async () => {
    const rollDice = vi.fn().mockResolvedValue({
      formula: '1d20+5',
      total: 15,
      breakdown: '(10) + 5',
      timestamp: '2025-01-01T00:00:00Z',
    });
    const result = await registry.execute(
      'foundry_chat',
      { action: 'roll', formula: '1d20+5', reason: 'Stealth' },
      context({ rollDice }),
    );
    expect(rollDice).toHaveBeenCalledWith('1d20+5', 'Stealth');
    expect(result.content[0]?.text).toContain('**Total:** 15');
  });

  it('names the valid actions when the action is missing or unknown', async () => {
    await expect(registry.execute('foundry_chat', {}, context())).rejects.toThrow(
      /action must be one of read, roll/,
    );
    await expect(registry.execute('foundry_chat', { action: 'yell' }, context())).rejects.toThrow(
      /\(got 'yell'\)/,
    );
  });

  it('reports the missing field and the fields of that action', async () => {
    const error = await registry
      .execute('foundry_chat', { action: 'roll' }, context())
      .catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error.message).toContain("foundry_chat action 'roll'");
    expect(error.message).toContain('formula');
    expect(error.message).toMatch(/Fields for this action: formula, reason\?\.$/);
  });

  it('enforces per-action bounds', async () => {
    await expect(
      registry.execute('foundry_chat', { action: 'read', limit: 500 }, context()),
    ).rejects.toThrow(/limit/);
  });
});
