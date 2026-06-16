/**
 * Shared object-reader dispatch registry.
 *
 * Maps an objectType discriminator → the underlying get_*_info handler, its tool
 * name, and an args builder. Single source of truth reused by:
 *   - get_object_info  (single object, with type-specific options passthrough)
 *   - batch_get_info   (many objects in parallel)
 *
 * The handler functions live in their own files and stay there — consolidating
 * the MCP *surface* into get_object_info does not delete the handlers.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { classInfoTool } from './classInfo.js';
import { tableInfoTool } from './tableInfo.js';
import { getFormInfoTool } from './formInfo.js';
import { getQueryInfoTool } from './queryInfo.js';
import { getViewInfoTool } from './viewInfo.js';
import { getEnumInfoTool } from './enumInfo.js';
import { getEdtInfoTool } from './edtInfo.js';
import { getReportInfoTool } from './reportInfo.js';
import { dataEntityInfoTool } from './dataEntityInfo.js';
import { menuItemInfoTool } from './menuItemInfo.js';
import { getServiceInfoTool } from './serviceInfo.js';
import { getMapInfoTool } from './mapInfo.js';
import { getConfigKeyInfoTool } from './configKeyInfo.js';
import { getSecurityPolicyInfoTool } from './securityPolicyInfo.js';
import { getMacroInfoTool } from './macroInfo.js';
import { tableExtensionInfoTool, formExtensionInfoTool, enumExtensionInfoTool, edtExtensionInfoTool, dataEntityExtensionInfoTool } from './tableExtensionInfo.js';
import { securityArtifactInfoTool } from './securityArtifactInfo.js';

export type InfoTool = (request: CallToolRequest, context: XppServerContext) => Promise<any>;

export interface ReaderDispatch {
  tool: InfoTool;
  toolName: string;
  /** Build the underlying handler args from the object name + optional type-specific options. */
  buildArgs: (name: string, options?: Record<string, unknown>) => Record<string, unknown>;
}

/** name + spread options; unknown option keys are stripped by each handler's zod schema. */
const byName = (key: string): ReaderDispatch['buildArgs'] =>
  (name, options) => ({ [key]: name, ...(options ?? {}) });

export const READER_DISPATCH: Record<string, ReaderDispatch> = {
  'class':              { tool: classInfoTool,            toolName: 'get_class_info',             buildArgs: byName('className') },
  'table':              { tool: tableInfoTool,            toolName: 'get_table_info',             buildArgs: byName('tableName') },
  'form':               { tool: getFormInfoTool,          toolName: 'get_form_info',              buildArgs: byName('formName') },
  'query':              { tool: getQueryInfoTool,         toolName: 'get_query_info',             buildArgs: byName('queryName') },
  'view':               { tool: getViewInfoTool,          toolName: 'get_view_info',              buildArgs: byName('viewName') },
  'enum':               { tool: getEnumInfoTool,          toolName: 'get_enum_info',              buildArgs: byName('enumName') },
  'edt':                { tool: getEdtInfoTool,           toolName: 'get_edt_info',               buildArgs: byName('edtName') },
  'report':             { tool: getReportInfoTool,        toolName: 'get_report_info',            buildArgs: byName('reportName') },
  'data-entity':        { tool: dataEntityInfoTool,       toolName: 'get_data_entity_info',       buildArgs: byName('entityName') },
  'menu-item':          { tool: menuItemInfoTool,         toolName: 'get_menu_item_info',         buildArgs: byName('name') },
  'service':            { tool: getServiceInfoTool,       toolName: 'get_service_info',           buildArgs: byName('serviceName') },
  'map':                { tool: getMapInfoTool,           toolName: 'get_map_info',               buildArgs: byName('mapName') },
  'config-key':         { tool: getConfigKeyInfoTool,     toolName: 'get_config_key_info',        buildArgs: byName('name') },
  'security-policy':    { tool: getSecurityPolicyInfoTool,toolName: 'get_security_policy_info',   buildArgs: byName('policyName') },
  'macro':              { tool: getMacroInfoTool,         toolName: 'get_macro_info',             buildArgs: byName('macroName') },
  'table-extension':         { tool: tableExtensionInfoTool,       toolName: 'get_table_extension_info',        buildArgs: (name, options) => ({ tableName: name.includes('.') ? name.split('.')[0] : name, ...(options ?? {}) }) },
  'form-extension':          { tool: formExtensionInfoTool,        toolName: 'get_form_extension_info',         buildArgs: (name, options) => ({ baseName:   name.includes('.') ? name.split('.')[0] : name, ...(options ?? {}) }) },
  'enum-extension':          { tool: enumExtensionInfoTool,        toolName: 'get_enum_extension_info',         buildArgs: (name, options) => ({ baseName:   name.includes('.') ? name.split('.')[0] : name, ...(options ?? {}) }) },
  'edt-extension':           { tool: edtExtensionInfoTool,         toolName: 'get_edt_extension_info',          buildArgs: (name, options) => ({ baseName:   name.includes('.') ? name.split('.')[0] : name, ...(options ?? {}) }) },
  'data-entity-extension':   { tool: dataEntityExtensionInfoTool,  toolName: 'get_data_entity_extension_info',  buildArgs: (name, options) => ({ baseName:   name.includes('.') ? name.split('.')[0] : name, ...(options ?? {}) }) },
  'class-extension':         { tool: classInfoTool,                toolName: 'get_class_info',                  buildArgs: byName('className') },
  'security-privilege': { tool: securityArtifactInfoTool, toolName: 'get_security_artifact_info', buildArgs: n => ({ name: n, artifactType: 'privilege' }) },
  'security-duty':      { tool: securityArtifactInfoTool, toolName: 'get_security_artifact_info', buildArgs: n => ({ name: n, artifactType: 'duty' }) },
  'security-role':      { tool: securityArtifactInfoTool, toolName: 'get_security_artifact_info', buildArgs: n => ({ name: n, artifactType: 'role' }) },
};

/** Homogeneous "object by name → structure" types exposed by get_object_info. */
export const OBJECT_INFO_TYPES = [
  'class', 'table', 'form', 'query', 'view', 'enum', 'edt', 'report',
  'data-entity', 'menu-item', 'service', 'map', 'config-key', 'security-policy', 'macro',
  // Extension types
  'table-extension', 'class-extension', 'form-extension', 'enum-extension',
  'edt-extension', 'data-entity-extension',
] as const;

/** Types accepted by batch_get_info (superset incl. extensions + security artifacts). */
export const BATCH_INFO_TYPES = [
  ...OBJECT_INFO_TYPES,
  'security-privilege', 'security-duty', 'security-role',
] as const;
