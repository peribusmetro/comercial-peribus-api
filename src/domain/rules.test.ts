import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  documentUnits,
  evaluateDocument,
  ruleDuplicateMajorPart,
  ruleLateRelink,
  ruleMultiUnit,
  ruleStockPurchase,
  ruleUnitMismatch,
  tallyMajorParts,
  type MajorPartGroup,
} from './rules';
import type { FolioContext, StagedDocument, StagedMovement } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mv(partial: Partial<StagedMovement> = {}): StagedMovement {
  return {
    movement_id: 1,
    document_id: 1,
    product_id: 1,
    product_code: null,
    product_name: null,
    units: 1,
    price: 0,
    total: 0,
    extra_text_one: null,
    ...partial,
  };
}

function doc(partial: Partial<StagedDocument> = {}): StagedDocument {
  return {
    document_id: 1,
    document_concept_id: 21,
    concept_name: 'COMPRA DIRECTA UNIDAD',
    document_series: 'COMDU',
    folio: 1,
    date: new Date('2026-07-23T00:00:00Z'),
    business_name: 'PROVEEDOR',
    rfc: 'XXX010101XXX',
    nature: 1,
    cancelled: 0,
    total: 1000,
    extra_text_one: null,
    extra_text_two: null,
    extra_text_three: null,
    sql_timestamp_parsed: null,
    movements: [],
    ...partial,
  };
}

function folio(partial: Partial<FolioContext> = {}): FolioContext {
  return {
    pid: 'M-260723-67',
    kind: 'maintenance',
    entityId: 52965,
    ecoNumber: 'AP-087',
    openedAt: new Date('2026-07-23T00:00:00Z'),
    ...partial,
  };
}

const CLUTCH_GROUP: MajorPartGroup = {
  groupCode: 'CLUTCH',
  groupName: 'Clutch / embrague',
  maxPerFolio: 1,
  productCodes: new Set(['MTO-0037', 'MTO-0038', 'MTO-1319', 'MTO-0947', 'MTO-1177']),
};

const NO_OPTS = { majorPartGroups: [], folioTally: {} };

// ---------------------------------------------------------------------------
// R1 — Unidad discordante  (imagen 1 e imagen 3)
// ---------------------------------------------------------------------------

describe('R1 — unidad discordante', () => {
  it('detecta el caso COMDU 6771: TP-062 contra folio de TP-082', () => {
    const d = doc({ document_id: 6771, extra_text_two: 'TP-062' });
    const f = folio({ pid: 'M-260715-29', ecoNumber: 'TP-082' });

    const found = ruleUnitMismatch(d, f);

    expect(found).toHaveLength(1);
    expect(found[0].ruleCode).toBe('R1_UNIT_MISMATCH');
    expect(found[0].severity).toBe('high');
    expect(found[0].action).toBe('quarantine');
    expect(found[0].detail).toContain('TP-062');
    expect(found[0].detail).toContain('TP-082');
  });

  it('detecta el caso COMDU 6525: AP-057 contra folio de AP-087', () => {
    const d = doc({ document_id: 52853, extra_text_two: 'AP-057' });
    expect(ruleUnitMismatch(d, folio())).toHaveLength(1);
  });

  it('no se queja cuando la unidad coincide', () => {
    const d = doc({ extra_text_two: 'AP-087' });
    expect(ruleUnitMismatch(d, folio())).toHaveLength(0);
  });

  it('tolera diferencias de formato en la captura', () => {
    const d = doc({ extra_text_two: 'ap-87' });
    expect(ruleUnitMismatch(d, folio({ ecoNumber: 'AP-087' }))).toHaveLength(0);
  });

  it('no inventa veredicto si el documento no declara unidad', () => {
    expect(ruleUnitMismatch(doc(), folio())).toHaveLength(0);
  });

  it('no inventa veredicto si el folio no tiene unidad registrada', () => {
    const d = doc({ extra_text_two: 'AP-001' });
    expect(ruleUnitMismatch(d, folio({ ecoNumber: null }))).toHaveLength(0);
  });

  it('usa el eco de los movimientos cuando el documento no lo declara', () => {
    const d = doc({ movements: [mv({ extra_text_one: 'AP-057' })] });
    expect(ruleUnitMismatch(d, folio({ ecoNumber: 'AP-087' }))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R2 — Compra a stock  (imagen 3: FP10181)
// ---------------------------------------------------------------------------

describe('R2 — compra a stock', () => {
  it('detecta el caso FP10181 por mención explícita de STOCK', () => {
    const d = doc({
      document_id: 52459,
      concept_name: 'COMPRA ALMACEN',
      extra_text_two: 'AP-035, AP-100 STOCK',
      total: 30064.95,
    });

    const found = ruleStockPurchase(d, folio());

    expect(found).toHaveLength(1);
    expect(found[0].ruleCode).toBe('R2_STOCK_PURCHASE');
    expect(found[0].action).toBe('quarantine');
  });

  it('detecta compra de almacén sin unidad declarada', () => {
    const d = doc({ concept_name: 'COMPRA ALMACEN', extra_text_two: null });
    expect(ruleStockPurchase(d, folio())).toHaveLength(1);
  });

  it('respeta una compra de almacén que sí trae unidad', () => {
    const d = doc({ concept_name: 'COMPRA ALMACEN', extra_text_two: 'AP-087' });
    expect(ruleStockPurchase(d, folio())).toHaveLength(0);
  });

  it('no toca una compra directa normal', () => {
    const d = doc({ concept_name: 'COMPRA DIRECTA UNIDAD', extra_text_two: 'AP-087' });
    expect(ruleStockPurchase(d, folio())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3 — Multi-unidad  (imagen 3: FP10181)
// ---------------------------------------------------------------------------

describe('R3 — documento multi-unidad', () => {
  it('detecta "AP-035, AP-100 STOCK" como dos unidades', () => {
    const d = doc({ extra_text_two: 'AP-035, AP-100 STOCK' });
    const found = ruleMultiUnit(d, folio());

    expect(found).toHaveLength(1);
    expect(found[0].ruleCode).toBe('R3_MULTI_UNIT');
    expect(found[0].evidence.document_units).toEqual(['AP-035', 'AP-100']);
  });

  it('no se queja con una sola unidad', () => {
    expect(ruleMultiUnit(doc({ extra_text_two: 'AP-087' }), folio())).toHaveLength(0);
  });

  it('no se queja sin unidades', () => {
    expect(ruleMultiUnit(doc(), folio())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R4 — Re-ligado tardío  (imagen 3: columna "Última modificación")
// ---------------------------------------------------------------------------

describe('R4 — re-ligado tardío', () => {
  it('detecta el caso COMDU 6525: capturado 24 jul, modificado 28 ago', () => {
    const d = doc({
      date: new Date('2026-07-24T00:00:00Z'),
      sql_timestamp_parsed: new Date('2026-08-28T00:00:00Z'),
    });

    const found = ruleLateRelink(d, folio());

    expect(found).toHaveLength(1);
    expect(found[0].ruleCode).toBe('R4_LATE_RELINK');
    expect(found[0].action).toBe('flag'); // marca, no retiene
    expect(found[0].evidence.diff_days).toBe(35);
  });

  it('ignora modificaciones dentro de la ventana normal', () => {
    const d = doc({
      date: new Date('2026-07-24T00:00:00Z'),
      sql_timestamp_parsed: new Date('2026-07-26T00:00:00Z'),
    });
    expect(ruleLateRelink(d, folio())).toHaveLength(0);
  });

  it('no aplica si falta el timestamp del ERP', () => {
    expect(ruleLateRelink(doc(), folio())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R6 — Pieza mayor duplicada  (M-260723-67: tres clutchs)
// ---------------------------------------------------------------------------

describe('R6 — pieza mayor duplicada', () => {
  it('cuenta las piezas mayores de un documento', () => {
    const d = doc({
      movements: [
        mv({ product_code: 'MTO-0947', units: 2 }), // KIT DE CLUTCH AUT. x2
        mv({ product_code: 'MTO-0292', units: 1 }), // balero: no es pieza mayor
      ],
    });

    expect(tallyMajorParts(d, [CLUTCH_GROUP])).toEqual({ CLUTCH: 2 });
  });

  it('detecta el segundo clutch cuando el folio ya tiene uno', () => {
    const d = doc({ movements: [mv({ product_code: 'MTO-0037', units: 1 })] });

    const found = ruleDuplicateMajorPart(d, folio(), [CLUTCH_GROUP], { CLUTCH: 1 });

    expect(found).toHaveLength(1);
    expect(found[0].ruleCode).toBe('R6_DUPLICATE_MAJOR_PART');
    expect(found[0].action).toBe('quarantine');
    expect(found[0].evidence.combined).toBe(2);
  });

  it('detecta KIT DE CLUTCH x2 aunque el folio esté vacío', () => {
    const d = doc({ movements: [mv({ product_code: 'MTO-0947', units: 2 })] });
    expect(ruleDuplicateMajorPart(d, folio(), [CLUTCH_GROUP], {})).toHaveLength(1);
  });

  it('acepta el primer clutch del folio', () => {
    const d = doc({ movements: [mv({ product_code: 'MTO-0037', units: 1 })] });
    expect(ruleDuplicateMajorPart(d, folio(), [CLUTCH_GROUP], {})).toHaveLength(0);
  });

  it('no cuenta tornillería ni accesorios como pieza mayor', () => {
    const d = doc({
      movements: [
        mv({ product_code: 'MTO-0208', units: 8 }), // tornillos de clutch
        mv({ product_code: 'MO-0031', units: 1 }), // mano de obra clutch
        mv({ product_code: 'MTO-0059', units: 1 }), // fanclutch: otra pieza
      ],
    });
    expect(ruleDuplicateMajorPart(d, folio(), [CLUTCH_GROUP], {})).toHaveLength(0);
  });

  it('trata las líneas sin cantidad como una pieza', () => {
    const d = doc({ movements: [mv({ product_code: 'MTO-0037', units: null })] });
    expect(tallyMajorParts(d, [CLUTCH_GROUP])).toEqual({ CLUTCH: 1 });
  });
});

// ---------------------------------------------------------------------------
// Evaluación integral
// ---------------------------------------------------------------------------

describe('evaluateDocument', () => {
  it('liga un documento limpio', () => {
    const d = doc({ extra_text_two: 'AP-087', extra_text_three: 'M-260723-67' });
    const result = evaluateDocument(d, folio(), NO_OPTS);

    expect(result.anomalies).toHaveLength(0);
    expect(result.shouldLink).toBe(true);
  });

  it('retiene ante una anomalía de cuarentena', () => {
    const d = doc({ extra_text_two: 'AP-057' });
    const result = evaluateDocument(d, folio(), NO_OPTS);

    expect(result.shouldLink).toBe(false);
  });

  it('liga marcado cuando solo hay anomalías de aviso', () => {
    const d = doc({
      extra_text_two: 'AP-087',
      extra_text_three: '260723-67', // sin prefijo → R5
    });
    const result = evaluateDocument(d, folio(), NO_OPTS);

    expect(result.anomalies.map((a) => a.ruleCode)).toContain('R5_AMBIGUOUS_FOLIO');
    expect(result.shouldLink).toBe(true);
  });

  it('acumula varias anomalías del mismo documento', () => {
    // FP10181: stock + multi-unidad a la vez
    const d = doc({
      concept_name: 'COMPRA ALMACEN',
      extra_text_two: 'AP-035, AP-100 STOCK',
    });
    const result = evaluateDocument(d, folio(), NO_OPTS);

    const codes = result.anomalies.map((a) => a.ruleCode);
    expect(codes).toContain('R2_STOCK_PURCHASE');
    expect(codes).toContain('R3_MULTI_UNIT');
    expect(result.shouldLink).toBe(false);
  });

  it('respeta las reglas desactivadas', () => {
    const d = doc({ extra_text_two: 'AP-057' });
    const result = evaluateDocument(d, folio(), {
      ...NO_OPTS,
      disabledRules: new Set(['R1_UNIT_MISMATCH' as const]),
    });

    expect(result.anomalies).toHaveLength(0);
    expect(result.shouldLink).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

describe('computeFingerprint', () => {
  it('es estable ante el mismo contenido', () => {
    const a = doc({ extra_text_two: 'AP-087' });
    const b = doc({ extra_text_two: 'AP-087' });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it('cambia si cambia la unidad capturada', () => {
    const before = computeFingerprint(doc({ extra_text_two: 'AP-087' }));
    const after = computeFingerprint(doc({ extra_text_two: 'AP-057' }));
    expect(before).not.toBe(after);
  });

  it('cambia si cambia el folio capturado', () => {
    const before = computeFingerprint(doc({ extra_text_three: 'M-260723-67' }));
    const after = computeFingerprint(doc({ extra_text_three: 'M-260601-38' }));
    expect(before).not.toBe(after);
  });

  it('cambia si cambian los productos del documento', () => {
    const before = computeFingerprint(doc({ movements: [mv({ product_code: 'MTO-0037' })] }));
    const after = computeFingerprint(doc({ movements: [mv({ product_code: 'MTO-0947' })] }));
    expect(before).not.toBe(after);
  });

  it('no depende del orden de los movimientos', () => {
    const a = doc({
      movements: [mv({ product_code: 'MTO-0037' }), mv({ product_code: 'MTO-0292' })],
    });
    const b = doc({
      movements: [mv({ product_code: 'MTO-0292' }), mv({ product_code: 'MTO-0037' })],
    });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });
});

// ---------------------------------------------------------------------------
// documentUnits
// ---------------------------------------------------------------------------

describe('documentUnits', () => {
  it('prefiere extra_text_two pero suma extra_text_one', () => {
    const d = doc({ extra_text_two: 'AP-087', extra_text_one: 'AP-087' });
    expect(documentUnits(d).ecoNumbers).toEqual(['AP-087']);
  });

  it('cae a los movimientos cuando el documento no declara unidad', () => {
    const d = doc({ movements: [mv({ extra_text_one: 'TP-015' })] });
    expect(documentUnits(d).ecoNumbers).toEqual(['TP-015']);
  });
});
