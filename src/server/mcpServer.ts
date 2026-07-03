/**
 * MCP Server Configuration and Setup
 * Registers tools, resources, and prompts for X++ code completion
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../tools/toolHandler.js';
import { registerResources } from '../resources/index.js';
import { registerCodeReviewPrompt } from '../prompts/codeReview.js';
import type { XppServerContext } from '../types/context.js';
import { SERVER_MODE, LOCAL_TOOLS, ALWAYS_TOOLS } from './serverMode.js';
import { TOOL_ANNOTATIONS } from './toolAnnotations.js';
import { getConfigManager } from '../utils/configManager.js';

const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';
import { setLastRoots, recordRootsListChanged } from '../utils/stdioSessionInfo.js';
import { toolSchemas } from './toolSchemas/index.js';

export type { XppServerContext };
export { SERVER_MODE, LOCAL_TOOLS, WRITE_TOOLS } from './serverMode.js';
export type { ServerMode } from './serverMode.js';

/**
 * Convert a file:// URI to a local path.
 * Duplicated from transport.ts to keep mcpServer.ts self-contained
 * (no circular dep between transport ↔ mcpServer).
 * Handles both Windows (drive-letter) and POSIX (Linux/macOS, Azure) paths.
 */
function fileUriToPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('file:///')) {
    const decoded = decodeURIComponent(uri.slice('file:///'.length));
    if (process.platform === 'win32') {
      return decoded.replace(/\//g, '\\');
    }
    // POSIX: restore the leading slash stripped by slice('file:///'.length)
    return '/' + decoded;
  }
  if (uri.startsWith('file://')) {
    const decoded = decodeURIComponent(uri.slice('file://'.length));
    return process.platform === 'win32' ? decoded.replace(/\//g, '\\') : decoded;
  }
  // Already a local path — Windows drive letter, UNC share, or POSIX absolute
  if (uri.length > 2 && (uri[1] === ':' || uri.startsWith('\\\\') || uri.startsWith('/'))) return uri;
  return null;
}

/**
 * Apply MCP roots list to ConfigManager.
 * Called after InitializedNotification and RootsListChanged notification.
 * All roots are passed so that unambiguous single-project matches work correctly
 * even when VS 2022 sends multiple roots (open project folders).
 */
function applyRootsToConfig(roots: Array<{ uri: string }>): void {
  if (!roots?.length) {
    // VS 2022 sends empty roots/list when closing a solution (transition state).
    // Keep the current detection result — the next roots/list_changed will update it.
    if (DEBUG_LOGGING) {
      process.stderr.write('[mcpServer] roots/list received (0 root(s)) — solution closing or no workspace open\n');
    }
    setLastRoots([]);
    return;
  }

  // Log all received roots for diagnostics
  if (DEBUG_LOGGING) {
    process.stderr.write(`[mcpServer] roots/list received (${roots.length} root(s)):\n`);
    roots.forEach((r, i) => process.stderr.write(`  [${i}] ${r.uri}\n`));
  }

  // Persist URIs in the stdio session singleton so get_workspace_info can display them.
  setLastRoots(roots.map(r => r.uri));

  // Convert all URIs to local paths
  const paths = roots
    .map(r => fileUriToPath(r.uri))
    .filter((p): p is string => p !== null);

  if (paths.length === 0) return;

  // Pass all paths; configManager will pick the most specific unambiguous one.
  // After detection completes, log what solution/project was resolved so it's
  // easy to verify in the log that the correct project was picked.
  getConfigManager().setRuntimeContextFromRoots(paths).then(() => {
    if (DEBUG_LOGGING) {
      const { modelName, source, projectPath, solutionPath, workspacePath } =
        getConfigManager().getDetectionSummary();
      process.stderr.write(
        `[mcpServer] ✅ Project detection result:\n` +
        `   Model name  : ${modelName ?? '(unknown)'} (source: ${source})\n` +
        `   Project path: ${projectPath  ?? '(not set)'}\n` +
        `   Solution    : ${solutionPath ?? '(not set)'}\n` +
        `   Workspace   : ${workspacePath ?? '(not set)'}\n`
      );
    }
  }).catch(err => {
    process.stderr.write(`[mcpServer] ⚠️ setRuntimeContextFromRoots error: ${err}\n`);
  });
}

export function createXppMcpServer(context: XppServerContext): Server {
  const serverNameSuffix = SERVER_MODE !== 'full' ? ` (${SERVER_MODE})` : '';
  const server = new Server(
    {
      name: `d365fo-mcp-server${serverNameSuffix}`,
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
    }
  );

  // -----------------------------------------------------------------------
  // Workspace roots: VS Code (stdio mode) sends roots after initialization.
  // Request them immediately after `initialized` notification, then keep
  // up-to-date on `notifications/roots/list_changed`.
  // -----------------------------------------------------------------------
  server.setNotificationHandler(InitializedNotificationSchema, async () => {
    if (DEBUG_LOGGING) {
      process.stderr.write(
        `[mcpServer ${new Date().toISOString().slice(11, 23)}] ⚡ 'initialized' notification received — requesting roots/list\n`
      );
    }
    // Only stdio clients (VS Code, VS 2022) advertise the roots capability.
    // HTTP / Azure clients do not — skipping the call avoids a -32001 timeout
    // that would otherwise be logged as a spurious warning in Azure Monitor.
    if (!server.getClientCapabilities()?.roots) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Client has no roots capability — skipping roots/list\n`);
      }
      return;
    }
    // HTTP transports (Azure App Service, MCP_FORCE_HTTP) are request-response only —
    // the server cannot initiate requests back to the client. Even if the client
    // declares `roots` capability, calling roots/list would always time out (-32001).
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (isHttpMode) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  HTTP mode — skipping roots/list (transport is request-response only)\n`);
      }
      return;
    }
    // Instanced mode
    if (await getConfigManager().isStaticallyConfigured()) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list (instanced mode)\n`);
      }
      return;
    }
    try {
      const result = await server.request(
        { method: 'roots/list', params: {} },
        ListRootsResultSchema
      );
      applyRootsToConfig(result.roots ?? []);
    } catch (e) {
      // Unlikely now that we checked capabilities first, but still guard
      // against network errors or other unexpected failures.
      process.stderr.write(`[mcpServer] ⚠️  roots/list failed: ${e}\n`);
    }
  });

  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    recordRootsListChanged();
    if (DEBUG_LOGGING) {
      process.stderr.write(
        `[mcpServer ${new Date().toISOString().slice(11, 23)}] 🔄 'roots/list_changed' notification — re-requesting roots/list\n`
      );
    }
    const isHttpMode = !!process.env.WEBSITES_PORT || process.env.MCP_FORCE_HTTP === 'true';
    if (!server.getClientCapabilities()?.roots || isHttpMode) {
      return;
    }
    // Instanced mode: workspace is immutable per server instance — the
    // notification is irrelevant and the request would time out over mcp-remote.
    if (await getConfigManager().isStaticallyConfigured()) {
      if (DEBUG_LOGGING) {
        process.stderr.write(`[mcpServer] ℹ️  Static config complete — skipping roots/list on change (instanced mode)\n`);
      }
      return;
    }
    try {
      const result = await server.request(
        { method: 'roots/list', params: {} },
        ListRootsResultSchema
      );
      applyRootsToConfig(result.roots ?? []);
    } catch {}
  });

  // Register centralized tool handler
  registerToolHandler(server, context);

  // Register resources (single dispatcher — class + workspace schemes)
  registerResources(server, context);

  // Register prompts (includes system instructions)
  registerCodeReviewPrompt(server, context);

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = {
      tools: [...toolSchemas],
    };

    // Attach MCP tool annotations (display title + behavior hints).
    // VS Code shows annotations.title in the chat UI ("Ran Search D365FO index"
    // instead of "Ran search") and uses readOnlyHint to skip write confirmations.
    allTools.tools = allTools.tools.map(t => ({
      ...t,
      annotations: TOOL_ANNOTATIONS[t.name],
    })) as typeof allTools.tools;

    // Apply server mode filter. ALWAYS_TOOLS bypass the partition and stay
    // published in every mode.
    if (SERVER_MODE === 'read-only') {
      allTools.tools = allTools.tools.filter(t => !LOCAL_TOOLS.has(t.name) || ALWAYS_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for read-only mode: ${allTools.tools.length} tools (local tools excluded)`);
    } else if (SERVER_MODE === 'write-only') {
      allTools.tools = allTools.tools.filter(t => LOCAL_TOOLS.has(t.name) || ALWAYS_TOOLS.has(t.name));
      console.error(`[MCP Server] Tool list filtered for write-only mode: ${allTools.tools.length} tools (${Array.from(LOCAL_TOOLS).join(', ')})`);
    } else {
      console.error(`[MCP Server] Tool list in full mode: ${allTools.tools.length} tools (no filtering)`);
    }

    return allTools;
  });

  return server;
}
