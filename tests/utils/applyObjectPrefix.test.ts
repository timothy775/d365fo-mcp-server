/**
 * applyObjectPrefix tests (PR #483 — dot-notation model-name suffix fix)
 *
 * Covers:
 *   - SPECIAL CASE A (dot-notation):
 *       • suffix ends with "extension" → always normalize to correctly-cased {infix}Extension
 *       • suffix has NO "extension" word (bare model name as VS generates) → return as-is
 *   - SPECIAL CASE B: extension class (_Extension) → inject infix
 *   - NORMAL CASE: regular objects → prefix prepended
 *
 * Regression guards:
 *   - "CTSOExtension" MUST be normalized to "CtsoExtension" (casing invariant from original code)
 *   - "ContosoExtension" with infix "Con" MUST be normalized to "ConExtension"
 *   - VS-generated bare model-name suffix must NOT receive a prepended prefix (original bug)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { applyObjectPrefix } from '../../src/utils/modelClassifier';

const originalPrefix = process.env.EXTENSION_PREFIX;

afterEach(() => {
  if (originalPrefix === undefined) {
    delete process.env.EXTENSION_PREFIX;
  } else {
    process.env.EXTENSION_PREFIX = originalPrefix;
  }
});

// ---------------------------------------------------------------------------
// SPECIAL CASE A — dot-notation, suffix ends with "extension" → normalize
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE A, suffix ends with "extension"', () => {
  it('already-correct form returns as-is (ConExtension → ConExtension)', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.ConExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('REGRESSION: CTSOExtension with EXTENSION_PREFIX=CTSO_ → CtsoExtension (casing normalized)', () => {
    // startsWith-based A1 in original PR would have returned "CTSOExtension" unchanged.
    // Correct behavior: always normalize casing.
    process.env.EXTENSION_PREFIX = 'CTSO_';
    expect(applyObjectPrefix('VendTrans.CTSOExtension', 'CTSO')).toBe('VendTrans.CtsoExtension');
  });

  it('REGRESSION: ContosoExtension with infix Con → ConExtension (A1 startsWith must NOT fire)', () => {
    // startsWith("con") would have matched "ContosoExtension", preventing normalization.
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.ContosoExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('foreign infix is replaced: OtherExtension → ConExtension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.OtherExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('all-lowercase suffix is normalized', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('HCMWorker.adextension', 'AdventureWorks')).toBe('HCMWorker.AdventureWorksExtension');
  });

  it('bare .Extension becomes {infix}Extension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('PurchTable.Extension', 'Con')).toBe('PurchTable.ConExtension');
  });

  it('uses lastIndexOf — multi-dot base name is handled correctly', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('My.Nested.OtherExtension', 'Con')).toBe('My.Nested.ConExtension');
  });

  it('underscore-style prefix: XY_ → infix Xy', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('VendTable.OtherExtension', 'XY')).toBe('VendTable.XyExtension');
  });
});

// ---------------------------------------------------------------------------
// SPECIAL CASE A — dot-notation, suffix has NO "extension" word → return as-is
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE A, bare model-name suffix (no "extension")', () => {
  it('ORIGINAL BUG FIX: SalesOrderHeaderV4Entity.Contoso is NOT prepended with Con', () => {
    // Before fix: fell through to NORMAL CASE → "ContosoSalesOrderHeaderV4Entity.Contoso"
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesOrderHeaderV4Entity.Contoso', 'Contoso'))
      .toBe('SalesOrderHeaderV4Entity.Contoso');
  });

  it('bare suffix with non-matching infix also returns as-is', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesOrderHeaderV4Entity.AdventureWorks', 'Con'))
      .toBe('SalesOrderHeaderV4Entity.AdventureWorks');
  });

  it('bare model-name suffix with underscore-style prefix returns as-is', () => {
    process.env.EXTENSION_PREFIX = 'CTSO_';
    expect(applyObjectPrefix('PurchTable.Contoso', 'CTSO'))
      .toBe('PurchTable.Contoso');
  });
});

// ---------------------------------------------------------------------------
// SPECIAL CASE B — extension classes (_Extension)
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE B (_Extension class)', () => {
  it('injects infix before _Extension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesFormLetter_Extension', 'Contoso'))
      .toBe('SalesFormLetterContoso_Extension');
  });

  it('returns as-is when infix already present', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesFormLetterContoso_Extension', 'Contoso'))
      .toBe('SalesFormLetterContoso_Extension');
  });

  it('injects PascalCase infix for underscore-style prefix (XY_ → Xy)', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('SalesFormLetter_Extension', 'XY'))
      .toBe('SalesFormLetterXy_Extension');
  });
});

// ---------------------------------------------------------------------------
// NORMAL CASE — regular objects
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — NORMAL CASE (regular objects)', () => {
  it('prepends PascalCase prefix', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('MyTable', 'Contoso')).toBe('ContosoMyTable');
  });

  it('does not double-prefix (case-insensitive)', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('ContosoMyTable', 'Contoso')).toBe('ContosoMyTable');
    expect(applyObjectPrefix('contosoMyTable', 'Contoso')).toBe('contosoMyTable');
  });

  it('prepends underscore-style prefix', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('MyTable', 'XY')).toBe('XY_MyTable');
  });

  it('does not double-prefix underscore-style', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('XY_MyTable', 'XY')).toBe('XY_MyTable');
  });

  it('returns unchanged when prefix is empty', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('MyTable', '')).toBe('MyTable');
  });
});
