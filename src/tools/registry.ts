/**
 * @fileoverview Tool registry: the single source of listed and callable tools
 *
 * Tools are filtered two ways: by toolset (`FOUNDRY_TOOLSETS`) and by whether
 * writes are enabled (`FOUNDRY_WRITE_ENABLED`). A filtered-out tool is neither
 * listed nor callable.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import {
  TOOLSETS,
  type Tool,
  type ToolAnnotations,
  type ToolContext,
  type ToolResult,
  type Toolset,
} from './base.js';

/** Toolsets enabled when `FOUNDRY_TOOLSETS` is not set: everything except `script`. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = TOOLSETS.filter((t) => t !== 'script');

export interface RegistryOptions {
  /** Expose tools that can mutate the world. */
  writeEnabled: boolean;
  /** Toolsets to expose. Defaults to DEFAULT_TOOLSETS. */
  toolsets?: readonly Toolset[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: ToolAnnotations;
}

/**
 * Parse a comma-separated `FOUNDRY_TOOLSETS` value. Unknown names are reported
 * through `onUnknown` and ignored; an empty or missing value means the default.
 */
export function parseToolsets(
  raw: string | undefined,
  onUnknown?: (name: string) => void,
): Toolset[] {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    return [...DEFAULT_TOOLSETS];
  }
  const valid: Toolset[] = [];
  for (const name of names) {
    if ((TOOLSETS as readonly string[]).includes(name)) {
      valid.push(name as Toolset);
    } else {
      onUnknown?.(name);
    }
  }
  return valid;
}

/**
 * Tool registry manages all available tools
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private readonly writeEnabled: boolean;
  private readonly toolsets: ReadonlySet<Toolset>;

  constructor(options: RegistryOptions) {
    this.writeEnabled = options.writeEnabled;
    this.toolsets = new Set(options.toolsets ?? DEFAULT_TOOLSETS);
  }

  /**
   * Register a tool in the registry
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool '${tool.name}' is already registered, replacing...`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Whether a registered tool is exposed under the current options. */
  private isEnabled(tool: Tool): boolean {
    return this.toolsets.has(tool.toolset) && (this.writeEnabled || !tool.requiresWrite);
  }

  /**
   * Execute a tool by name with given arguments
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    if (!this.isEnabled(tool)) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        !this.toolsets.has(tool.toolset)
          ? `Tool '${name}' is disabled: toolset '${tool.toolset}' is not in FOUNDRY_TOOLSETS.`
          : `Tool '${name}' changes the world and is disabled. Set FOUNDRY_WRITE_ENABLED=true and restart the server to allow it.`,
      );
    }

    return await tool.execute(args, context);
  }

  /**
   * Names of the tools that are exposed
   */
  getToolNames(): string[] {
    return Array.from(this.tools.values())
      .filter((t) => this.isEnabled(t))
      .map((t) => t.name);
  }

  /**
   * Definitions of the exposed tools, for ListTools
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((t) => this.isEnabled(t))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }));
  }

  /**
   * Check if a tool is registered and exposed
   */
  has(name: string): boolean {
    const tool = this.tools.get(name);
    return tool !== undefined && this.isEnabled(tool);
  }

  /**
   * Get a registered tool, exposed or not
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * All registered tools regardless of filtering (for tests and docs)
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }
}
