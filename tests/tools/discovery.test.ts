/**
 * Discovery Tools Tests
 * Covers: search, batch_search, search_extensions, find_references
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTool } from '../../src/tools/search';
import { batchSearchTool } from '../../src/tools/batchSearch';
import { extensionSearchTool } from '../../src/tools/extensionSearch';
import { findReferencesTool } from '../../src/tools/findReferences';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const makeSymbol = (overrides: Partial<any> = {}) => ({
  id: 1,
  name: 'CustTable',
  type: 'table' as const,
  parentName: undefined,
  signature: undefined,
  filePath: 'K:\\PackagesLocalDirectory\\MyPkg\\MyModel\\AxTable\\CustTable.xml',
  model: 'ApplicationSuite',
  ...overrides,
});

const buildContext = (overrides: Partial<XppServerContext> = {}): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getClassMethods: vi.fn(() => []),
    getTableFields: vi.fn(() => []),
    searchLabels: vi.fn(() => []),
    getCustomModels: vi.fn(() => []),
    getAllSymbolNames: vi.fn(() => []),
    getSymbolsByTerm: vi.fn(() => new Map()),
    searchCustomExtensions: vi.fn(() => []),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) },
    getReadDb: vi.fn(function(this: any) { return this.db; }),
  } as any,
  cache: {
    get: vi.fn(async () => null),
    getFuzzy: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    generateSearchKey: vi.fn((q: string) => `search:${q}`),
    generateExtensionSearchKey: vi.fn((q: string) => `ext:${q}`),
  } as any,
  parser: {} as any,
  workspaceScanner: {} as any,
  hybridSearch: { searchWorkspace: vi.fn(async () => []) } as any,
  ...overrides,
});

// ─── search ─────────────────────────────────────────────────────────────────

describe('search', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns formatted results for a known symbol', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([
      makeSymbol({ name: 'CustTable', type: 'table' }),
      makeSymbol({ id: 2, name: 'createCustomer', type: 'method', parentName: 'CustTable', signature: 'void createCustomer()' }),
    ]);

    const result = await searchTool(req('search', { query: 'CustTable' }), ctx);

    expect(result.content[0].text).toContain('CustTable');
    expect(result.content[0].text).toContain('TABLE');
  });

  it('returns empty message when no symbols found', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([]);
    const result = await searchTool(req('search', { query: 'NonExistent' }), ctx);
    expect(result.content[0].text).toMatch(/no.*found|0 result/i);
  });

  it('filters by objectType when provided', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([
      makeSymbol({ type: 'class', name: 'CustHelper' }),
    ]);
    const result = await searchTool(req('search', { query: 'Cust', objectType: 'class' }), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustHelper');
  });

  it('returns error on missing query', async () => {
    const result = await searchTool(req('search', {}), ctx);
    expect(result.isError).toBe(true);
  });

  it('respects limit parameter', async () => {
    (ctx.symbolIndex.searchSymbols as any).mockReturnValue([makeSymbol()]);
    const result = await searchTool(req('search', { query: 'Cust', limit: 5 }), ctx);
    expect(result.isError).toBeFalsy();
  });

  it('returns results from symbolIndex when bridge is unavailable', async () => {
    const result = await searchTool(req('search', { query: 'CustTable' }), ctx);
    expect(result.content[0].text).toContain('CustTable');
    expect(ctx.symbolIndex.searchSymbols).toHaveBeenCalled();
  });
});

// ─── batch_search ────────────────────────────────────────────────────────────

describe('batch_search', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    (ctx.symbolIndex.searchSymbols as any).mockImplementation(({ query }: any) =>
      query === 'CustTable'
        ? [makeSymbol({ name: 'CustTable', type: 'table' })]
        : [makeSymbol({ name: 'VendTable', type: 'table' })],
    );
  });

  it('executes multiple queries and returns combined results', async () => {
    const result = await batchSearchTool(
      req('batch_search', {
        queries: [
          { query: 'CustTable', limit: 5 },
          { query: 'VendTable', limit: 5 },
        ],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('CustTable');
    expect(text).toContain('VendTable');
  });

  it('rejects more than 10 queries', async () => {
    const queries = Array.from({ length: 11 }, (_, i) => ({ query: `Q${i}`, limit: 5 }));
    const result = await batchSearchTool(req('batch_search', { queries }), ctx);
    expect(result.isError).toBe(true);
  });

  it('rejects empty queries array', async () => {
    const result = await batchSearchTool(req('batch_search', { queries: [] }), ctx);
    expect(result.isError).toBe(true);
  });

  it('applies globalTypeFilter to queries without explicit type', async () => {
    const result = await batchSearchTool(
      req('batch_search', {
        queries: [{ query: 'CustTable', limit: 5 }],
        globalTypeFilter: ['table'],
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

// ─── search_extensions ───────────────────────────────────────────────────────

describe('search_extensions', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns extension matches from custom models', async () => {
    (ctx.symbolIndex.searchCustomExtensions as any).mockReturnValue([
      makeSymbol({ name: 'CustTable_ISV_Extension', type: 'table-extension', model: 'ISVModel' }),
    ]);
    (ctx.symbolIndex.getCustomModels as any).mockReturnValue(['ISVModel']);

    const result = await extensionSearchTool(req('search_extensions', { query: 'CustTable' }), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustTable');
  });

  it('returns no-results message when nothing found', async () => {
    (ctx.symbolIndex.searchCustomExtensions as any).mockReturnValue([]);
    (ctx.symbolIndex.getCustomModels as any).mockReturnValue([]);
    const result = await extensionSearchTool(req('search_extensions', { query: 'Unknown' }), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/no.*found|0 match|no extension/i);
  });

  it('returns error on missing query', async () => {
    const result = await extensionSearchTool(req('search_extensions', {}), ctx);
    expect(result.isError).toBe(true);
  });

  it('filters by prefix when provided', async () => {
    (ctx.symbolIndex.searchCustomExtensions as any).mockReturnValue([
      makeSymbol({ name: 'ISV_CustHelper', type: 'class', model: 'ISVModel' }),
    ]);
    const result = await extensionSearchTool(
      req('search_extensions', { query: 'Cust', prefix: 'ISV_' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

// ─── find_references ─────────────────────────────────────────────────────────

describe('find_references', () => {
  let ctx: XppServerContext;

  beforeEach(() => { ctx = buildContext(); });

  it('returns references to a class', async () => {
    const mockStmt = {
      all: vi.fn(() => [
        { file_path: 'K:\\pkg\\MyModel\\AxClass\\MyClass.xml', model: 'MyModel', name: 'MyClass' },
      ]),
      get: vi.fn(() => undefined),
    };
    (ctx.symbolIndex.db as any).prepare = vi.fn(() => mockStmt);

    const result = await findReferencesTool(
      req('find_references', { targetName: 'CustTable' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns not-found message when no references exist', async () => {
    const mockStmt = { all: vi.fn(() => []), get: vi.fn(() => undefined) };
    (ctx.symbolIndex.db as any).prepare = vi.fn(() => mockStmt);

    const result = await findReferencesTool(
      req('find_references', { targetName: 'UnusedClass' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/no.*found|not found|0 reference/i);
  });

  it('returns error when symbolName is missing', async () => {
    const result = await findReferencesTool(req('find_references', {}), ctx);
    expect(result.isError).toBe(true);
  });
});
