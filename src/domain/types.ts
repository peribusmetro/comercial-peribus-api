/** Tipos compartidos del dominio del validador. */

export type RuleCode =
  | 'R1_UNIT_MISMATCH'
  | 'R2_STOCK_PURCHASE'
  | 'R3_MULTI_UNIT'
  | 'R4_LATE_RELINK'
  | 'R5_AMBIGUOUS_FOLIO'
  | 'R6_DUPLICATE_MAJOR_PART';

export type Severity = 'high' | 'medium' | 'low';

/** quarantine = no se liga. flag = se liga, pero marcado. */
export type RuleAction = 'quarantine' | 'flag';

export type LinkType = 'maintenance' | 'accident';

/** Documento de AdminPAQ ya en staging, con sus movimientos. */
export interface StagedDocument {
  document_id: number;
  document_concept_id: number | null;
  concept_name: string | null;
  document_series: string | null;
  folio: number | null;
  date: Date | null;
  business_name: string | null;
  rfc: string | null;
  nature: number | null;
  cancelled: number;
  total: number | null;
  extra_text_one: string | null;
  extra_text_two: string | null;
  extra_text_three: string | null;
  sql_timestamp_parsed: Date | null;
  movements: StagedMovement[];
}

export interface StagedMovement {
  movement_id: number;
  document_id: number;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  units: number | null;
  price: number | null;
  total: number | null;
  extra_text_one: string | null;
}

/** El folio contra el que se evalúa, tal como está en la app. */
export interface FolioContext {
  pid: string;
  kind: LinkType;
  /** id de maintenances/accidents en Supabase */
  entityId: number;
  /** Unidad dueña del folio. Es el discriminador principal (R1). */
  ecoNumber: string | null;
  openedAt: Date | null;
}

/** Una anomalía detectada, antes de persistirse. */
export interface DetectedAnomaly {
  documentId: number;
  folioPid: string | null;
  ruleCode: RuleCode;
  severity: Severity;
  action: RuleAction;
  /** Explicación legible para quien revisa en la app. */
  detail: string;
  /** Datos crudos que dispararon la regla, para auditoría. */
  evidence: Record<string, unknown>;
}

/** Resultado de evaluar un documento contra un folio candidato. */
export interface EvaluationResult {
  documentId: number;
  folioPid: string | null;
  anomalies: DetectedAnomaly[];
  /** true si nada impide ligar (puede haber anomalías de solo marcado). */
  shouldLink: boolean;
  /** Presente cuando un veredicto humano previo decidió el caso. */
  verdictApplied?: {
    verdict: 'approved' | 'rejected' | 'corrected';
    reason: string;
    reviewedBy: string;
  };
}
