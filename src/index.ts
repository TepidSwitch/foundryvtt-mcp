#!/usr/bin/env node

/**
 * FoundryVTT Model Context Protocol Server
 *
 * This server provides integration between FoundryVTT and AI models through the Model Context Protocol (MCP).
 * It enables AI assistants to interact with FoundryVTT instances for RPG campaign management,
 * character handling, and game automation.
 *
 * @fileoverview Main entry point for the FoundryVTT MCP Server
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 * @see {@link https://github.com/anthropics/mcp} Model Context Protocol
 * @see {@link https://foundryvtt.com/} FoundryVTT Virtual Tabletop
 */

// Must precede every other import: see src/load-env.ts (#206).
import './load-env.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { DiagnosticsClient } from './diagnostics/client.js';
import { FoundryClient, type FoundryClientConfig } from './foundry/client.js';
import { ConnectionManager, setConnectionStatusProvider } from './foundry/connection-manager.js';
import { defaultAuditPath } from './foundry/write-audit.js';
import {
  getAllResources,
  getAllTools,
  routeResourceRequest,
  routeToolRequest,
} from './tools/index.js';
import { DiagnosticSystem } from './utils/diagnostics.js';
import { logger } from './utils/logger.js';

/**
 * Main FoundryVTT MCP Server class that handles all communication
 * between AI models and FoundryVTT instances.
 */
class FoundryMCPServer {
  private server: Server;
  private foundryClient: FoundryClient;
  private connection: ConnectionManager;
  private diagnosticsClient: DiagnosticsClient;
  private diagnosticSystem: DiagnosticSystem;

  /**
   * Creates a new FoundryMCPServer instance.
   * Initializes the MCP server, FoundryVTT client, and sets up all handlers.
   */
  constructor() {
    this.server = new Server(
      {
        name: config.serverName,
        version: config.serverVersion,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    // Initialize FoundryVTT client with configuration
    const clientConfig: FoundryClientConfig = {
      baseUrl: config.foundry.url,
      socketPath: config.foundry.socketPath,
      timeout: config.foundry.timeout,
      retryAttempts: config.foundry.retryAttempts,
      retryDelay: config.foundry.retryDelay,
      writeEnabled: config.foundry.writeEnabled,
      dryRun: config.foundry.dryRun,
      // FOUNDRY_AUDIT_FILE=off keeps the write log in memory only.
      auditFile:
        config.foundry.auditFile === 'off'
          ? null
          : (config.foundry.auditFile ?? defaultAuditPath()),
    };
    if (config.foundry.apiKey) {
      clientConfig.apiKey = config.foundry.apiKey;
    }
    if (config.foundry.username) {
      clientConfig.username = config.foundry.username;
    }
    if (config.foundry.password) {
      clientConfig.password = config.foundry.password;
    }
    if (config.foundry.userId) {
      clientConfig.userId = config.foundry.userId;
    }
    this.foundryClient = new FoundryClient(clientConfig);
    this.connection = new ConnectionManager(this.foundryClient);
    setConnectionStatusProvider(() => this.connection.status());

    // Initialize DiagnosticsClient
    this.diagnosticsClient = new DiagnosticsClient(this.foundryClient);

    // Initialize DiagnosticSystem
    this.diagnosticSystem = new DiagnosticSystem(this.foundryClient);

    this.setupHandlers();
  }

  /**
   * Sets up all MCP request handlers for tools, resources, and functionality.
   * @private
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('Listing available tools');
      return {
        tools: getAllTools(),
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.info('Listing available resources');
      return {
        resources: getAllResources(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.info('Executing tool', { name, args });

      try {
        // Handshake is already done; wait for (or re-establish) the Foundry link.
        // The health tool must answer even while disconnected — it explains why.
        if (name !== 'get_health_status') {
          await this.connection.ensureConnected();
        }
        const route = () =>
          routeToolRequest(
            name,
            args || {},
            this.foundryClient,
            this.diagnosticsClient,
            this.diagnosticSystem,
          ) as Promise<CallToolResult>;
        const dryBefore = this.foundryClient.getDryRunWriteCount();
        const withDryRunBanner = (result: CallToolResult): CallToolResult => {
          if (this.foundryClient.getDryRunWriteCount() === dryBefore) {
            return result;
          }
          return {
            ...result,
            content: [
              {
                type: 'text',
                text: '🧪 DRY RUN (FOUNDRY_DRY_RUN=true): nothing was written to Foundry. The output below shows what would have happened.',
              },
              ...result.content,
            ],
          };
        };
        try {
          return withDryRunBanner(await route());
        } catch (error) {
          // The link dropped before the request was sent (safe to repeat, even
          // for writes): re-establish it and try exactly once more.
          if (
            name !== 'get_health_status' &&
            error instanceof Error &&
            /not connected|Not connected/.test(error.message)
          ) {
            logger.warn('Foundry link was down; reconnecting and retrying once', { name });
            this.foundryClient.markSessionLost();
            await this.connection.ensureConnected();
            return withDryRunBanner(await route());
          }
          throw error;
        }
      } catch (error) {
        logger.error('Tool execution failed:', error);

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      logger.info('Reading resource', { uri });

      try {
        await this.connection.ensureConnected();
        return await routeResourceRequest(uri, this.foundryClient, this.diagnosticsClient);
      } catch (error) {
        logger.error('Resource read failed:', error);

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Resource read failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });
  }

  /**
   * Connects to FoundryVTT and starts the MCP server.
   * @returns Promise that resolves when the server is running
   */
  async start(): Promise<void> {
    try {
      // Answer the MCP handshake immediately; Foundry login (slow, can fail
      // transiently) happens in the background with retry.
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      logger.info('FoundryVTT MCP Server started successfully');
      this.connection.start();
    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
  }

  /**
   * Gracefully shuts down the server and connections.
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    try {
      await this.foundryClient.disconnect();
      logger.info('FoundryVTT MCP Server shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

/**
 * Main entry point - creates and starts the server
 */
async function main(): Promise<void> {
  const server = new FoundryMCPServer();

  // Pre-connect banner — emitted on stderr so the stdio JSON-RPC channel on
  // stdout stays clean once StdioServerTransport.connect() takes it over.
  // The smoke test (scripts/smoke-test.js) keys on this string to verify the
  // binary loads without crashing at construction time, before any network
  // call to FoundryVTT.
  process.stderr.write('🎲 FoundryVTT MCP Server starting...\n');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await server.shutdown();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', { promise, reason });
    process.exit(1);
  });

  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start FoundryVTT MCP Server:', error);
    process.exit(1);
  }
}

// Run the server if this file is executed directly.
// Use realpath so the comparison works when npm/npx installs the bin as a
// symlink into node_modules/.bin (the literal `file://${argv[1]}` compare
// fails for symlinked invocations and on macOS where /tmp -> /private/tmp).
const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return import.meta.url === `file://${argv1}`;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    logger.error('Server startup failed:', error);
    process.exit(1);
  });
}
