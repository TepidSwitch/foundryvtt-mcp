/**
 * @fileoverview Domain tools: one MCP tool per domain, selected by `action`
 *
 * A domain tool (`foundry_actors`, `foundry_combat_edit`, ...) groups several
 * related actions behind one tool name. Each action carries its own Zod schema
 * and handler. The published JSON Schema merges the action schemas into one
 * flat object (`action` plus every action's fields) because MCP clients expect
 * a top-level `type: "object"`; the description lists which fields each action
 * takes, and Zod validates the real per-action shape on every call.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import type { Tool, ToolAnnotations, ToolContext, ToolResult, Toolset } from './base.js';

type AnyObject = z.ZodObject<z.ZodRawShape>;

/**
 * One action of a domain tool, with its argument type erased so actions with
 * different schemas can live in one record.
 */
export interface ActionDef {
  description: string;
  schema: AnyObject;
  run: (args: never, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Parsed arguments as handlers expect them. Zod types an optional field as
 * `T | undefined`, but a parsed object never carries an explicit `undefined`
 * (absent input keys stay absent), and handlers are typed for
 * exactOptionalPropertyTypes - so drop the `undefined`, recursively.
 */
export type ParsedArgs<T> = T extends readonly (infer U)[]
  ? ParsedArgs<U>[]
  : T extends object
    ? { [K in keyof T]: ParsedArgs<Exclude<T[K], undefined>> }
    : T;

/**
 * Declare an action. `run` receives the parsed arguments (without `action`).
 */
export function action<S extends AnyObject>(def: {
  description: string;
  schema: S;
  run: (args: ParsedArgs<z.infer<S>>, ctx: ToolContext) => Promise<ToolResult>;
}): ActionDef {
  return def as unknown as ActionDef;
}

/** Empty argument schema for actions that take no arguments. */
export const noArgs = z.object({});

export interface DomainToolSpec {
  name: string;
  title: string;
  toolset: Toolset;
  /** What the tool is for, in one or two sentences (action list is appended). */
  description: string;
  /** Write tools are hidden unless FOUNDRY_WRITE_ENABLED=true. */
  write: boolean;
  /** True only when an action deletes or overwrites data. Ignored for read tools. */
  destructive?: boolean;
  /** True when repeating a call with the same arguments changes nothing more. */
  idempotent?: boolean;
  actions: Record<string, ActionDef>;
}

interface JsonSchemaProp {
  [key: string]: unknown;
}

function describeFields(schema: AnyObject): string {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  const names = Object.keys(json.properties ?? {});
  if (names.length === 0) {
    return 'no arguments';
  }
  return names.map((n) => (required.has(n) ? n : `${n}?`)).join(', ');
}

/**
 * A tool made of named actions, validated with Zod.
 */
export class DomainTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; [key: string]: unknown };
  readonly annotations: ToolAnnotations;
  readonly toolset: Toolset;
  readonly requiresWrite: boolean;
  private readonly actions: Record<string, ActionDef>;
  private readonly variants = new Map<string, AnyObject>();

  constructor(spec: DomainToolSpec) {
    this.name = spec.name;
    this.toolset = spec.toolset;
    this.requiresWrite = spec.write;
    this.actions = spec.actions;
    const actionNames = Object.keys(spec.actions);
    if (actionNames.length === 0) {
      throw new Error(`Domain tool '${spec.name}' has no actions`);
    }

    const properties: Record<string, JsonSchemaProp> = {
      action: {
        type: 'string',
        enum: actionNames,
        description: `Which operation to run: ${actionNames.join(', ')}.`,
      },
    };
    const lines: string[] = [];
    for (const [actionName, def] of Object.entries(spec.actions)) {
      this.variants.set(actionName, def.schema.extend({ action: z.literal(actionName) }));
      const json = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, JsonSchemaProp>;
      };
      for (const [prop, value] of Object.entries(json.properties ?? {})) {
        if (!(prop in properties)) {
          properties[prop] = value;
        }
      }
      lines.push(`- ${actionName} (${describeFields(def.schema)}): ${def.description}`);
    }

    this.description = `${spec.description}\n\nActions (fields marked ? are optional; give only the fields of the chosen action):\n${lines.join('\n')}`;
    this.inputSchema = { type: 'object', properties, required: ['action'] };
    this.annotations = {
      title: spec.title,
      readOnlyHint: !spec.write,
      destructiveHint: spec.write ? (spec.destructive ?? false) : false,
      idempotentHint: spec.write ? (spec.idempotent ?? false) : true,
      openWorldHint: false,
    };
  }

  /** Names of the actions this tool exposes. */
  getActionNames(): string[] {
    return Object.keys(this.actions);
  }

  /** The declaration of one action (for tests and docs). */
  getAction(name: string): ActionDef | undefined {
    return this.actions[name];
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const requested = args.action;
    const names = this.getActionNames();
    if (typeof requested !== 'string' || !this.variants.has(requested)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters for tool '${this.name}': action must be one of ${names.join(', ')}${
          typeof requested === 'string' ? ` (got '${requested}')` : ''
        }`,
      );
    }

    const variant = this.variants.get(requested) as AnyObject;
    const parsed = variant.safeParse(args);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters for ${this.name} action '${requested}': ${problems}. Fields for this action: ${describeFields((this.actions[requested] as ActionDef).schema)}.`,
      );
    }

    logger.debug(`Executing tool: ${this.name}.${requested}`, { args });
    const { action: _action, ...rest } = parsed.data as Record<string, unknown>;
    return (this.actions[requested] as ActionDef).run(rest as never, context);
  }
}
