/**
 * security_info Tool — unified security-lookup entry point.
 *
 * Replaces two security tools with one discriminated by `mode`:
 *   • artifact → details + full hierarchy of a privilege/duty/role
 *                (Role → Duties → Privileges → Entry Points)
 *   • coverage → reverse chain: which roles/duties/privileges cover an object
 *
 * Handler files stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { securityArtifactInfoTool } from './securityArtifactInfo.js';
import { securityCoverageInfoTool } from './securityCoverageInfo.js';

export const SECURITY_MODES = ['artifact', 'coverage'] as const;
export type SecurityMode = (typeof SECURITY_MODES)[number];

const SecurityInfoArgsSchema = z
  .object({
    mode: z.enum(SECURITY_MODES).describe(
      'artifact → details + hierarchy of a named privilege/duty/role; ' +
      'coverage → which roles/duties/privileges grant access to a given object.',
    ),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function securityInfoTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = SecurityInfoArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ security_info: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { mode, ...rest } = parsed.data;
  if (mode === 'coverage') {
    return securityCoverageInfoTool(subRequest('get_security_coverage_for_object', rest), context);
  }
  return securityArtifactInfoTool(subRequest('get_security_artifact_info', rest), context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
