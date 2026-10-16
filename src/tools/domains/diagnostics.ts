/**
 * @fileoverview Diagnostics tools: foundry_diagnostics (read)
 */

import { z } from 'zod';
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
import type { ToolContext } from '../base.js';
import { action, DomainTool, noArgs } from '../domain.js';
import {
  handleDiagnoseErrors,
  handleGetHealthStatus,
  handleGetRecentLogs,
  handleGetSystemHealth,
  handleSearchLogs,
} from '../handlers/diagnostics.js';

const level = z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Log level filter');
const REST_NOTE = 'Requires the REST API module (FOUNDRY_API_KEY); fails without it.';

function diagnostics(ctx: ToolContext): DiagnosticsClient {
  if (!ctx.diagnosticsClient) {
    throw new Error('Diagnostics client is not available');
  }
  return ctx.diagnosticsClient;
}

function diagnosticSystem(ctx: ToolContext): DiagnosticSystem {
  if (!ctx.diagnosticSystem) {
    throw new Error('Diagnostic system is not available');
  }
  return ctx.diagnosticSystem;
}

export const diagnosticsTool = new DomainTool({
  name: 'foundry_diagnostics',
  title: 'Foundry diagnostics',
  toolset: 'diagnostics',
  write: false,
  description:
    "Check the connection to Foundry and the server's health and logs. Start with action health when something looks wrong.",
  actions: {
    health: action({
      description:
        'Combined health report: connection state, world title/system/core version, server health (users, uptime, memory, recent errors). The world section is marked stale when the cache stopped following live changes (a dropped connection) - run foundry_world refresh. Sections needing the REST API module report as unavailable instead of failing. Answers even while disconnected.',
      schema: noArgs,
      run: async (_a, ctx) => {
        const result = await handleGetHealthStatus({}, ctx.foundryClient, diagnostics(ctx));
        if (!ctx.comfyui) {
          return result;
        }
        // ComfyUI is optional: report it only when COMFYUI_URL is set.
        const comfy = await ctx.comfyui.checkHealth();
        const line = comfy.available
          ? `✅ Reachable at ${ctx.comfyui.baseUrl} (${comfy.responseTimeMs} ms)${comfy.gpu ? `, GPU: ${comfy.gpu}` : ''}`
          : `❌ Not reachable at ${ctx.comfyui.baseUrl}: ${comfy.error}. Start ComfyUI with --listen 0.0.0.0 and allow TCP 8188 in its firewall.`;
        return {
          ...result,
          content: [
            ...result.content,
            { type: 'text', text: `\n**ComfyUI (map generation):**\n${line}` },
          ],
        };
      },
    }),
    system: action({
      description: `Server health report: status (healthy/warning/critical), Foundry and system versions, world id, uptime, users and GMs, modules, clients, memory, log buffer and error rate. ${REST_NOTE}`,
      schema: noArgs,
      run: (a, ctx) => handleGetSystemHealth(a, diagnostics(ctx)),
    }),
    search_logs: action({
      description: `Search the server logs for a string. The match count is the server's total; limit caps how many are shown (default 50, max 1000). Levels info, warn and error work; "debug" is reported unsupported. ${REST_NOTE}`,
      schema: z.object({
        query: z.string().describe('Text to look for'),
        level,
        limit: z.number().optional().describe('Entries to show (default 50)'),
      }),
      run: (a, ctx) => handleSearchLogs(a, diagnostics(ctx)),
    }),
    logs: action({
      description: `Recent server log entries, optionally by level or since a timestamp. ${REST_NOTE}`,
      schema: z.object({
        limit: z.number().min(1).max(100).optional().describe('Entries (default 20, max 100)'),
        level,
        since: z.string().optional().describe('Only entries after this ISO timestamp'),
      }),
      run: (a, ctx) => handleGetRecentLogs(a, diagnostics(ctx)),
    }),
    diagnose: action({
      description:
        'Stub: returns a fixed "no errors detected" summary regardless of input and reflects nothing about the server. Use logs for real content.',
      schema: z.object({
        category: z.string().optional().describe('Error category'),
      }),
      run: (a, ctx) => handleDiagnoseErrors(a, diagnosticSystem(ctx)),
    }),
  },
});
