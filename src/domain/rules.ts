import { createHash } from 'node:crypto';
import { extractEcoNumbers, extractFolios } from './normalize';
import type {
  DetectedAnomaly,
  FolioContext,
  StagedDocument,
  RuleCode,
  Severity,
  RuleAction,
} from './types';

/**
 * Motor de reglas del validador.
 *
 * Cada regla es una función pura: recibe el documento y el contexto del folio,
 * devuelve anomalías. Sin efectos secundarios, sin acceso a base de datos —
 * así se pueden probar con casos reales y razonar sobre ellas una por una.
 *
 * Las reglas nacen de casos reales documentados en evidence/:
 *   R1 — imagen 1: COMDU 6767 (TP-082) y COMDU 6771 (TP-062) al mismo folio
 *   R2 — imagen 3: FP10181, compra a stock de $30,064.95 cargada a un folio
 *   R3 — imagen 3: FP10181 declara "AP-035, AP-100 STOCK"
 *   R4 — imagen 3: COMDU 6525 capturado 24 jul, modificado 28 ago
 *   R5 — folios sin prefijo, mayoría de los casos
 *   R6 — M-260723-67: tres clutchs distintos en un folio
 */

const RULE_META: Record<RuleCode, { severity: Severity; action: RuleAction }> = {
  R1_UNIT_MISMATCH: { severity: 'high', action: 'quarantine' },
  R2_STOCK_PURCHASE: { severity: 'high', action: 'quarantine' },
  R3_MULTI_UNIT: { severity: 'high', action: 'quarantine' },
  R4_LATE_RELINK: { severity: 'low', action: 'flag' },
  R5_AMBIGUOUS_FOLIO: { severity: 'low', action: 'flag' },
  R6_DUPLICATE_MAJOR_PART: { severity: 'medium', action: 'quarantine' },
};

function anomaly(
  documentId: number,
  folioPid: string | null,
  ruleCode: RuleCode,
  detail: string,
  evidence: Record<string, unknown>,
): DetectedAnomaly {
  const meta = RULE_META[ruleCode];
  return {
    documentId,
    folioPid,
    ruleCode,
    severity: meta.severity,
    action: meta.action,
    detail,
    evidence,
  };
}

/**
 * Huella de los campos del ERP que importan para la validación.
 *
 * Si cualquiera cambia en AdminPAQ, la huella cambia: las anomalías se
 * re-evalúan y los veredictos humanos previos caducan. Esto es lo que evita
 * que un "visto bueno" tape para siempre un documento que después se editó
 * (el patrón de la imagen 3).
 */
export function computeFingerprint(doc: StagedDocument): string {
  const parts = [
    doc.document_id,
    doc.extra_text_one ?? '',
    doc.extra_text_two ?? '',
    doc.extra_text_three ?? '',
    doc.total ?? 0,
    doc.cancelled,
    doc.document_concept_id ?? '',
    // Los movimientos importan: si cambian los productos, cambia el análisis.
    doc.movements
      .map((m) => `${m.product_code ?? ''}:${m.units ?? 0}`)
      .sort()
      .join('|'),
  ];

  return createHash('sha256').update(parts.join('~')).digest('hex').slice(0, 32);
}

/** Unidades que declara el documento, mirando ambos campos libres. */
export function documentUnits(doc: StagedDocument): {
  ecoNumbers: string[];
  mentionsStock: boolean;
} {
  // extra_text_two es el campo canónico de unidad; extra_text_one es respaldo
  // (y en movimientos es el que trae el eco).
  const fromTwo = extractEcoNumbers(doc.extra_text_two);
  const fromOne = extractEcoNumbers(doc.extra_text_one);

  const merged = new Set([...fromTwo.ecoNumbers, ...fromOne.ecoNumbers]);

  // Si el documento no declara unidad, se mira lo que digan sus movimientos.
  if (merged.size === 0) {
    for (const mv of doc.movements) {
      for (const eco of extractEcoNumbers(mv.extra_text_one).ecoNumbers) {
        merged.add(eco);
      }
    }
  }

  return {
    ecoNumbers: [...merged],
    mentionsStock: fromTwo.mentionsStock || fromOne.mentionsStock,
  };
}

// ---------------------------------------------------------------------------
// R1 — Unidad discordante
// ---------------------------------------------------------------------------

/**
 * La regla más importante. Un folio de mantenimiento pertenece a UNA unidad;
 * si el documento declara otra, no puede ser gasto de ese folio.
 *
 * Solo se dispara cuando hay datos de ambos lados: si el documento no declara
 * unidad o el folio no la tiene registrada, no se inventa un veredicto.
 */
export function ruleUnitMismatch(
  doc: StagedDocument,
  folio: FolioContext,
): DetectedAnomaly[] {
  const { ecoNumbers } = documentUnits(doc);

  if (ecoNumbers.length === 0 || !folio.ecoNumber) return [];

  const folioEco = folio.ecoNumber.toUpperCase();
  if (ecoNumbers.includes(folioEco)) return [];

  return [
    anomaly(
      doc.document_id,
      folio.pid,
      'R1_UNIT_MISMATCH',
      `El documento declara ${ecoNumbers.join(', ')} pero el folio ${folio.pid} es de la unidad ${folioEco}.`,
      {
        document_units: ecoNumbers,
        folio_unit: folioEco,
        extra_text_one: doc.extra_text_one,
        extra_text_two: doc.extra_text_two,
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// R2 — Compra a stock
// ---------------------------------------------------------------------------

/** Conceptos que por definición son reposición de inventario. */
const STOCK_CONCEPT_PATTERNS = [/COMPRA\s+ALMACEN/i, /COMPRA\s+ALMAC[EÉ]N/i];

/**
 * Una compra a inventario no es gasto de una unidad: entra al almacén y se
 * reparte después vía surtidos. Cargarla completa a un folio infla el gasto
 * (imagen 3: FP10181, $30,064.95).
 *
 * Se exige señal explícita de stock — no basta el concepto — porque "COMPRA
 * ALMACEN" también se usa legítimamente para compras que van directo a una
 * unidad, y en esos casos el ERP sí trae el eco.
 */
export function ruleStockPurchase(
  doc: StagedDocument,
  folio: FolioContext,
): DetectedAnomaly[] {
  const { ecoNumbers, mentionsStock } = documentUnits(doc);
  const conceptName = doc.concept_name ?? '';
  const isStockConcept = STOCK_CONCEPT_PATTERNS.some((p) => p.test(conceptName));

  // Señal fuerte: el texto dice STOCK/ALMACÉN explícitamente.
  if (mentionsStock) {
    return [
      anomaly(
        doc.document_id,
        folio.pid,
        'R2_STOCK_PURCHASE',
        `El documento está marcado como compra a stock/almacén; no es gasto atribuible al folio ${folio.pid}.`,
        { concept_name: conceptName, extra_text_two: doc.extra_text_two, units: ecoNumbers },
      ),
    ];
  }

  // Señal media: concepto de almacén y ninguna unidad declarada.
  if (isStockConcept && ecoNumbers.length === 0) {
    return [
      anomaly(
        doc.document_id,
        folio.pid,
        'R2_STOCK_PURCHASE',
        `Concepto "${conceptName}" sin unidad declarada: parece reposición de inventario, no gasto del folio ${folio.pid}.`,
        { concept_name: conceptName, extra_text_two: doc.extra_text_two },
      ),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// R3 — Documento multi-unidad
// ---------------------------------------------------------------------------

/**
 * Un documento que declara varias unidades no puede cargarse completo a un
 * folio: habría que repartirlo. Se retiene para que alguien decida
 * (imagen 3: FP10181 con "AP-035, AP-100 STOCK").
 */
export function ruleMultiUnit(
  doc: StagedDocument,
  folio: FolioContext,
): DetectedAnomaly[] {
  const { ecoNumbers } = documentUnits(doc);

  if (ecoNumbers.length <= 1) return [];

  return [
    anomaly(
      doc.document_id,
      folio.pid,
      'R3_MULTI_UNIT',
      `El documento declara ${ecoNumbers.length} unidades (${ecoNumbers.join(', ')}); requiere reparto antes de asignarse a ${folio.pid}.`,
      { document_units: ecoNumbers, total: doc.total },
    ),
  ];
}

// ---------------------------------------------------------------------------
// R4 — Re-ligado tardío
// ---------------------------------------------------------------------------

/**
 * Si el documento se modificó en el ERP mucho después de capturarse, es señal
 * de que alguien cambió el folio a mano (imagen 3: capturado 24 jul,
 * modificado 28 ago). No lo bloquea, pero lo marca para revisión.
 */
export const DEFAULT_LATE_RELINK_DAYS = 14;

export function ruleLateRelink(
  doc: StagedDocument,
  folio: FolioContext,
  thresholdDays: number = DEFAULT_LATE_RELINK_DAYS,
): DetectedAnomaly[] {
  if (!doc.date || !doc.sql_timestamp_parsed) return [];

  const diffDays = Math.floor(
    (doc.sql_timestamp_parsed.getTime() - doc.date.getTime()) / 86_400_000,
  );

  if (diffDays < thresholdDays) return [];

  return [
    anomaly(
      doc.document_id,
      folio.pid,
      'R4_LATE_RELINK',
      `El documento se capturó el ${doc.date.toISOString().slice(0, 10)} pero se modificó ${diffDays} días después en el ERP.`,
      {
        captured_at: doc.date.toISOString(),
        modified_at: doc.sql_timestamp_parsed.toISOString(),
        diff_days: diffDays,
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// R5 — Folio ambiguo
// ---------------------------------------------------------------------------

/**
 * Folio sin prefijo M-/S-: se asumió mantenimiento. Es la mayoría de los
 * casos, así que NO se retiene (paralizaría la operación); se liga marcado.
 */
export function ruleAmbiguousFolio(
  doc: StagedDocument,
  folio: FolioContext,
): DetectedAnomaly[] {
  const extraction = extractFolios(doc.extra_text_three);
  if (!extraction.ambiguous) return [];

  const candidate = extraction.candidates.find((c) => c.pid === folio.pid);
  if (!candidate || candidate.origin !== 'ambiguous') return [];

  return [
    anomaly(
      doc.document_id,
      folio.pid,
      'R5_AMBIGUOUS_FOLIO',
      `El folio se capturó sin prefijo ("${doc.extra_text_three}"); se interpretó como ${folio.pid}.`,
      { raw_folio: doc.extra_text_three, assumed_pid: folio.pid },
    ),
  ];
}

// ---------------------------------------------------------------------------
// R6 — Pieza mayor duplicada
// ---------------------------------------------------------------------------

export interface MajorPartGroup {
  groupCode: string;
  groupName: string;
  maxPerFolio: number;
  productCodes: Set<string>;
}

/** Piezas ya presentes en el folio por otros documentos ya ligados. */
export interface FolioPartTally {
  /** groupCode → unidades acumuladas */
  [groupCode: string]: number;
}

/**
 * Cuenta las piezas mayores que aporta este documento, por grupo.
 * Solo cuenta productos que pertenecen a algún grupo configurado.
 */
export function tallyMajorParts(
  doc: StagedDocument,
  groups: MajorPartGroup[],
): FolioPartTally {
  const tally: FolioPartTally = {};

  for (const mv of doc.movements) {
    if (!mv.product_code) continue;
    const code = mv.product_code.toUpperCase();

    for (const group of groups) {
      if (!group.productCodes.has(code)) continue;
      const units = mv.units && mv.units > 0 ? mv.units : 1;
      tally[group.groupCode] = (tally[group.groupCode] ?? 0) + units;
    }
  }

  return tally;
}

/**
 * Detecta que el folio acumule más de una pieza mayor del mismo grupo.
 *
 * Cuando se dispara, se retiene el documento completo: la regla sabe que hay
 * confusión pero no cuál de los documentos es el correcto, y adivinar sería
 * peor que retener (en M-260723-67 ninguno de los tres clutchs era el bueno).
 *
 * `existingTally` trae lo que ya aportan otros documentos ligados al folio.
 */
export function ruleDuplicateMajorPart(
  doc: StagedDocument,
  folio: FolioContext,
  groups: MajorPartGroup[],
  existingTally: FolioPartTally,
): DetectedAnomaly[] {
  const incoming = tallyMajorParts(doc, groups);
  const anomalies: DetectedAnomaly[] = [];

  for (const [groupCode, incomingUnits] of Object.entries(incoming)) {
    const group = groups.find((g) => g.groupCode === groupCode);
    if (!group) continue;

    const already = existingTally[groupCode] ?? 0;
    const combined = already + incomingUnits;

    if (combined <= group.maxPerFolio) continue;

    anomalies.push(
      anomaly(
        doc.document_id,
        folio.pid,
        'R6_DUPLICATE_MAJOR_PART',
        `El folio ${folio.pid} acumularía ${combined} piezas del grupo "${group.groupName}" (máximo esperado: ${group.maxPerFolio}).`,
        {
          group_code: groupCode,
          group_name: group.groupName,
          units_in_document: incomingUnits,
          units_already_linked: already,
          combined,
          max_per_folio: group.maxPerFolio,
        },
      ),
    );
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Evaluación completa
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  majorPartGroups: MajorPartGroup[];
  folioTally: FolioPartTally;
  /** Reglas desactivadas en validation_rules. */
  disabledRules?: Set<RuleCode>;
  /** Días para considerar tardía una modificación en el ERP (R4). */
  lateRelinkDays?: number;
}

/**
 * Corre todas las reglas de un documento contra un folio candidato.
 *
 * Devuelve las anomalías y si el documento puede ligarse: basta UNA anomalía
 * de acción `quarantine` para retenerlo.
 */
export function evaluateDocument(
  doc: StagedDocument,
  folio: FolioContext,
  options: EvaluateOptions,
): { anomalies: DetectedAnomaly[]; shouldLink: boolean } {
  const disabled = options.disabledRules ?? new Set<RuleCode>();

  const anomalies: DetectedAnomaly[] = [
    ...ruleUnitMismatch(doc, folio),
    ...ruleStockPurchase(doc, folio),
    ...ruleMultiUnit(doc, folio),
    ...ruleLateRelink(doc, folio, options.lateRelinkDays ?? DEFAULT_LATE_RELINK_DAYS),
    ...ruleAmbiguousFolio(doc, folio),
    ...ruleDuplicateMajorPart(doc, folio, options.majorPartGroups, options.folioTally),
  ].filter((a) => !disabled.has(a.ruleCode));

  const shouldLink = !anomalies.some((a) => a.action === 'quarantine');

  return { anomalies, shouldLink };
}
