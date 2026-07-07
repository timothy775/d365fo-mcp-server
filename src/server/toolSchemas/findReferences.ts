/**
 * MCP tool definition for `find_references` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const findReferencesTool = {
    name: 'find_references',
    description: 'Find all references (where-used) to a class, method, field, table, or enum. Essential for impact analysis before refactoring. For a method, SCOPE it to its declaring type — pass "Owner.method" (e.g. "SalesTable.initFromSalesQuotationTable"), set ownerName alongside a bare method name, or pass an AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"). A bare method name (no owner) matches that name on every type and over-reports.',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: {
          type: 'string',
          description: 'Target name. Method where-used: qualify as "Owner.method" or pass an AOT path "/Tables/<Table>/Methods/<method>" for a result scoped to one declaring type (matches Visual Studio xref). A bare method name is name-only and over-reports.'
        },
        targetType: {
          type: 'string',
          enum: ['class', 'method', 'field', 'table', 'enum', 'edt', 'form', 'query', 'view', 'report', 'all'],
          description: 'Type of the target to search for',
          default: 'all'
        },
        ownerName: {
          type: 'string',
          description: 'Declaring table/class/form that owns the method, when targetName is the bare method name. Scopes the where-used to that single type.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of references to return',
          default: 50
        },
      },
      required: ['targetName'],
    },
  };
