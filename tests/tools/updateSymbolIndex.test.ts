import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  existsSyncMock,
  readFileSyncMock,
  readFilePromiseMock,
  bridgeRefreshProviderMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  readFilePromiseMock: vi.fn(),
  bridgeRefreshProviderMock: vi.fn(async () => undefined),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

// xmlParser.ts (used by the table-reindexing path) reads files via fs/promises,
// a separate module from the sync `fs` mocked above.
vi.mock('fs/promises', () => ({
  default: { readFile: readFilePromiseMock },
  readFile: readFilePromiseMock,
}));

vi.mock('../../src/bridge/index.js', () => ({
  bridgeRefreshProvider: bridgeRefreshProviderMock,
}));

import { updateSymbolIndexTool } from '../../src/tools/updateSymbolIndex';
import type { XppServerContext } from '../../src/types/context';

/** Records every db.prepare(sql).run(...args) call so tests can assert on the exact SQL + bound values. */
function createRecordingDb() {
  const calls: Array<{ sql: string; args: any[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      run: vi.fn((...args: any[]) => {
        calls.push({ sql, args });
        return { changes: 0 };
      }),
    })),
    transaction: vi.fn((fn: any) => fn),
  };
  return { db, calls };
}

function createContext(db?: ReturnType<typeof createRecordingDb>['db']): XppServerContext {
  return {
    symbolIndex: {
      removeSymbolsByFile: vi.fn(() => ({ deletedCount: 0, objectNames: [] })),
      removeLabelsByFile: vi.fn(() => 0),
      bulkAddLabels: vi.fn(),
      db: db ?? {
        prepare: vi.fn(() => ({ run: vi.fn(() => ({ changes: 0 })) })),
        transaction: vi.fn((fn: any) => fn),
      },
      addSymbol: vi.fn(),
    } as any,
    parser: {} as any,
    cache: {
      delete: vi.fn(async () => undefined),
      deletePattern: vi.fn(async () => undefined),
      generateClassKey: vi.fn((name: string) => `xpp:class:${name}`),
      generateTableKey: vi.fn((name: string) => `xpp:table:${name}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: {} as any,
  } as XppServerContext;
}

describe('update_symbol_index label file reconciliation', () => {
  let context: XppServerContext;

  beforeEach(() => {
    context = createContext();
    vi.clearAllMocks();
  });

  it('reconciles a label file by removing stale rows and inserting current labels', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyLabels.en-US.label.txt';

    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('Existing=Existing text\n');
    (context.symbolIndex.removeLabelsByFile as any).mockReturnValue(2);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(context.symbolIndex.removeLabelsByFile).toHaveBeenCalledWith(filePath);
    expect(context.symbolIndex.bulkAddLabels).toHaveBeenCalledTimes(1);

    const insertedRows = (context.symbolIndex.bulkAddLabels as any).mock.calls[0][0];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      labelId: 'Existing',
      labelFileId: 'MyLabels',
      model: 'MyModel',
      language: 'en-US',
      text: 'Existing text',
      filePath,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Removed: 2');
    expect(result.content[0].text).toContain('Inserted: 1 label');
  });

  it('cleans labels when a label file is deleted', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyLabels.en-US.label.txt';

    existsSyncMock.mockReturnValue(false);
    (context.symbolIndex.removeLabelsByFile as any).mockReturnValue(3);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(context.symbolIndex.removeLabelsByFile).toHaveBeenCalledWith(filePath);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('3 label(s)');
  });
});

describe('update_symbol_index table re-indexing preserves field EDT/EnumType', () => {
  let context: XppServerContext;

  beforeEach(() => {
    context = createContext();
    vi.clearAllMocks();
  });

  it('stores the field\'s ExtendedDataType/EnumType as its signature, not the bare base type', async () => {
    // Regression (eval scenario 1 — Equipment Rental): the incremental table-reindex path stored
    // `signature: field.type` (the i:type-derived base type, e.g. "String"/"Enum") instead of the
    // field's actual EDT/EnumType. modifyD365File.ts's resolveFieldEdt() (used by
    // add-table-method to generate find()/exist() parameter types) reads this column expecting an
    // X++-usable type name; a base-type keyword is discarded by its own guard, which then falls
    // back to the bare field name — wrong for every custom-prefixed model, where the field name
    // (e.g. "MyId") and its EDT (e.g. "Contoso_MyId") are never identical. Reproduced live: right
    // after creating a table + calling update_symbol_index on it, add-table-method(find) on that
    // table emitted `public static MyTable find(RentEquipmentId _rentEquipmentId, ...)` — using
    // the bare field name as a (non-existent) type — instead of the real EDT.
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\MyTable.xml';
    existsSyncMock.mockReturnValue(true);
    readFilePromiseMock.mockResolvedValue(`<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyTable</Name>
  <Label>My table</Label>
  <TableGroup>Main</TableGroup>
  <Fields>
    <AxTableField xmlns="" i:type="AxTableFieldString">
      <Name>MyId</Name>
      <ExtendedDataType>ContosoMyId</ExtendedDataType>
    </AxTableField>
    <AxTableField xmlns="" i:type="AxTableFieldEnum">
      <Name>MyStatus</Name>
      <EnumType>ContosoMyStatus</EnumType>
    </AxTableField>
  </Fields>
</AxTable>`);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(result.isError).toBeFalsy();
    const addSymbolCalls = (context.symbolIndex.addSymbol as any).mock.calls.map((c: any[]) => c[0]);
    const myIdField = addSymbolCalls.find((s: any) => s.type === 'field' && s.name === 'MyId');
    const myStatusField = addSymbolCalls.find((s: any) => s.type === 'field' && s.name === 'MyStatus');

    expect(myIdField?.signature).toBe('ContosoMyId');
    expect(myStatusField?.signature).toBe('ContosoMyStatus');
  });
});

describe('update_symbol_index security object re-indexing populates coverage tables', () => {
  // Regression (eval scenario 5 — inventory aging analytics): the incremental
  // single-file indexer had no branch for security-privilege/-duty/-role (or
  // menu-item-*), so any of these objects created/re-indexed in the current
  // session fell into the generic tx() fallback, which only inserts a bare
  // symbols row. security_info(mode="coverage") and the security_duty_privileges
  // / security_role_duties / security_privilege_entries tables it queries were
  // never populated for same-session objects, so a privilege->duty->role chain
  // that was correctly wired in the XML (verified by direct read) was reported
  // as "0 privileges/duties/roles found" — a false negative in our own index,
  // not in the XML the create tools produced.
  let context: XppServerContext;
  let recording: ReturnType<typeof createRecordingDb>;

  beforeEach(() => {
    recording = createRecordingDb();
    context = createContext(recording.db);
    vi.clearAllMocks();
  });

  it('populates security_privilege_entries from a security-privilege file', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxSecurityPrivilege\\MyPrivilege.xml';
    existsSyncMock.mockReturnValue(true);
    readFilePromiseMock.mockResolvedValue(`<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyPrivilege</Name>
  <Label>@MyModel:MyPrivilegeLabel</Label>
  <DataEntityPermissions />
  <DirectAccessPermissions />
  <EntryPoints>
    <AxSecurityEntryPointReference>
      <Name>MyMenuItem</Name>
      <Grant><Read>Allow</Read></Grant>
      <ObjectName>MyMenuItem</ObjectName>
      <ObjectType>MenuItemDisplay</ObjectType>
      <Forms />
    </AxSecurityEntryPointReference>
  </EntryPoints>
  <FormControlOverrides />
</AxSecurityPrivilege>`);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(result.isError).toBeFalsy();
    const insertCall = recording.calls.find(c =>
      c.sql.includes('INSERT OR IGNORE INTO security_privilege_entries'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.args).toEqual(['MyPrivilege', 'MyMenuItem', 'MenuItemDisplay', 'Read:Allow', 'MyModel']);
  });

  it('populates security_duty_privileges from a security-duty file', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxSecurityDuty\\MyDuty.xml';
    existsSyncMock.mockReturnValue(true);
    readFilePromiseMock.mockResolvedValue(`<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyDuty</Name>
  <Label>@MyModel:MyDutyLabel</Label>
  <Privileges>
    <AxSecurityRolePermissionSet><Name>MyPrivilegeOne</Name></AxSecurityRolePermissionSet>
    <AxSecurityRolePermissionSet><Name>MyPrivilegeTwo</Name></AxSecurityRolePermissionSet>
  </Privileges>
</AxSecurityDuty>`);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(result.isError).toBeFalsy();
    const insertCalls = recording.calls.filter(c =>
      c.sql.includes('INSERT OR IGNORE INTO security_duty_privileges'));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls.map(c => c.args)).toEqual([
      ['MyDuty', 'MyPrivilegeOne', 'MyModel'],
      ['MyDuty', 'MyPrivilegeTwo', 'MyModel'],
    ]);
  });

  it('populates security_role_duties from a security-role file', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxSecurityRole\\MyRole.xml';
    existsSyncMock.mockReturnValue(true);
    readFilePromiseMock.mockResolvedValue(`<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyRole</Name>
  <Label>@MyModel:MyRoleLabel</Label>
  <DirectAccessPermissions />
  <Duties>
    <AxSecurityRoleDutyPermission><Name>MyDuty</Name></AxSecurityRoleDutyPermission>
  </Duties>
  <Privileges />
  <SubRoles />
</AxSecurityRole>`);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(result.isError).toBeFalsy();
    const insertCall = recording.calls.find(c =>
      c.sql.includes('INSERT OR IGNORE INTO security_role_duties'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.args).toEqual(['MyRole', 'MyDuty', 'MyModel']);
  });

  it('populates menu_item_targets from a menu-item-display file', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxMenuItemDisplay\\MyMenuItem.xml';
    existsSyncMock.mockReturnValue(true);
    readFilePromiseMock.mockResolvedValue(`<?xml version="1.0" encoding="utf-8"?>
<AxMenuItemDisplay xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
  <Name>MyMenuItem</Name>
  <Label>@MyModel:MyMenuItemLabel</Label>
  <Object>MyForm</Object>
  <ObjectType>Form</ObjectType>
</AxMenuItemDisplay>`);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(result.isError).toBeFalsy();
    const insertCall = recording.calls.find(c =>
      c.sql.includes('INSERT INTO menu_item_targets'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.args).toEqual([
      'MyMenuItem', 'menu-item-display', 'MyForm', 'Form', null, '@MyModel:MyMenuItemLabel', 'MyModel',
    ]);
  });
});
