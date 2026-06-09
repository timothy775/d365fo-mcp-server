/**
 * validate_xpp tool tests — offline BP validator
 */

import { describe, it, expect } from 'vitest';
import { validateXppTool } from '../../src/tools/validateXpp';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'validate_xpp', arguments: args },
});

const getText = (result: any): string => result.content?.[0]?.text ?? '';

// ─── Input validation ────────────────────────────────────────────────────────

describe('validate_xpp input validation', () => {
  it('returns error on missing code', async () => {
    const result = await validateXppTool(req({}));
    expect(result.isError).toBe(true);
  });

  it('returns no violations for empty code', async () => {
    const result = await validateXppTool(req({ code: '' }));
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toMatch(/no violation|0 violation/i);
  });
});

// ─── SEL rules ───────────────────────────────────────────────────────────────

describe('SEL rules', () => {
  it('SEL001: flags today() usage', async () => {
    const code = `
      QueryDate d = today();
      select firstOnly CustTable where CustTable.CreatedDate == today();
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).toContain('SEL001');
    expect(text).toMatch(/today\(\)/);
  });

  it('SEL001: clean code passes', async () => {
    const code = `
      QueryDate d = DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone());
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    const text = getText(result);
    expect(text).not.toContain('SEL001');
  });

  it('SEL002: flags forceLiterals', async () => {
    const code = `
      select forceLiterals firstOnly CustTable where CustTable.AccountNum == '1000';
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL002');
  });

  it('SEL004: flags nested while select', async () => {
    const code = `
      while select CustTable {
        while select SalesTable where SalesTable.CustAccount == CustTable.AccountNum {
          info(SalesTable.SalesId);
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('SEL004');
  });
});

// ─── COC rules ───────────────────────────────────────────────────────────────

describe('COC rules', () => {
  it('COC001: flags copied default param value in CoC wrapper', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      final class SalesFormLetter_MyExt_Extension {
        public void run(boolean _validate = false) {
          next run(_validate);
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC001');
  });

  it('COC002: flags [ExtensionOf] class that is not final', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      class SalesFormLetter_MyExt_Extension {
        public void run() {
          next run();
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC002');
  });

  it('COC003: flags extension class not ending in _Extension', async () => {
    const code = `
      [ExtensionOf(classStr(SalesFormLetter))]
      final class MySalesFormLetterExt {
        public void run() {
          next run();
        }
      }
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('COC003');
  });
});

// ─── BP rules ────────────────────────────────────────────────────────────────

describe('BP rules', () => {
  it('BP001: flags hardcoded string in info()', async () => {
    const code = `info("Record saved successfully.");`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP001');
  });

  it('BP002: flags doInsert()', async () => {
    const code = `custTable.doInsert();`;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP002');
  });

  it('BP003: flags generic doc-comment', async () => {
    const code = `
      /// MyHelper class.
      class MyHelper {}
    `;
    const result = await validateXppTool(req({ code, codeType: 'xpp' }));
    expect(getText(result)).toContain('BP003');
  });
});

// ─── XML rules ───────────────────────────────────────────────────────────────

describe('XML rules', () => {
  it('XML001: flags missing AlternateKey on index', async () => {
    const xml = `
      <AxTable>
        <Indexes>
          <AxTableIndex>
            <Name>CustIdx</Name>
            <AlternateKey>No</AlternateKey>
          </AxTableIndex>
        </Indexes>
      </AxTable>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).toContain('XML001');
  });

  it('XML001: passes when AlternateKey is Yes', async () => {
    const xml = `
      <AxTable>
        <Indexes>
          <AxTableIndex>
            <Name>CustIdx</Name>
            <AlternateKey>Yes</AlternateKey>
          </AxTableIndex>
        </Indexes>
      </AxTable>
    `;
    const result = await validateXppTool(req({ code: xml, codeType: 'xml-table' }));
    expect(getText(result)).not.toContain('XML001');
  });
});
