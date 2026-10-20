/**
 * @fileoverview Shared tool types
 *
 * Tool contract used by the registry (`registry.ts`) and the domain-tool
 * implementation (`domain.ts`).
 */

import type { DiagnosticsClient } from '../diagnostics/client.js';
import type { FoundryClient } from '../foundry/client.js';
import type { ComfyUIClient } from '../generate/comfyui.js';
import type { MapJobManager } from '../generate/map-jobs.js';
import type { DiagnosticSystem } from '../utils/diagnostics.js';

/**
 * Tool execution context containing all necessary dependencies
 */
export interface ToolContext {
  foundryClient: FoundryClient;
  diagnosticsClient?: DiagnosticsClient;
  diagnosticSystem?: DiagnosticSystem;
  /** Present only when COMFYUI_URL is set. */
  comfyui?: ComfyUIClient | undefined;
  maps?: MapJobManager | undefined;
  /** Default Scene folder name for generated maps (COMFYUI_SCENE_FOLDER). */
  sceneFolder?: string | undefined;
}

/**
 * Tool execution result matching the MCP CallToolResult shape.
 * Uses a structural interface to avoid pulling in zod-inferred literal types
 * while still enforcing the required content array structure.
 */
export interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

/**
 * MCP tool annotations (hints for clients; not enforced).
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Toolsets selectable with `FOUNDRY_TOOLSETS`. `script` is reserved for the
 * code-mode tool and is off unless named explicitly.
 */
export const TOOLSETS = [
  'actors',
  'items',
  'effects',
  'scenes',
  'tokens',
  'combat',
  'journals',
  'compendium',
  'audio',
  'chat',
  'world',
  'tables',
  'files',
  'generate',
  'history',
  'diagnostics',
  'canvas',
  'script',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/**
 * Base interface for all tools
 */
export interface Tool {
  /** Tool name (must match schema name) */
  readonly name: string;

  /** Tool description */
  readonly description: string;

  /** JSON Schema for the tool's input */
  readonly inputSchema: { type: 'object'; [key: string]: unknown };

  /** MCP annotations */
  readonly annotations: ToolAnnotations;

  /** Toolset this tool belongs to */
  readonly toolset: Toolset;

  /** True when the tool can mutate the world (hidden unless writes are enabled) */
  readonly requiresWrite: boolean;

  /**
   * Execute the tool with raw arguments (validated by the tool itself)
   * @param args - Input arguments
   * @param context - Tool execution context
   * @returns Tool execution result
   */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
