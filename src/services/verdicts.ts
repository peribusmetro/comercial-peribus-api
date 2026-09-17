import { validatorDb } from '../db/clients';
import type { RuleCode } from '../domain/types';
import { verdictKey, type Verdict, type VerdictKind, type VerdictScope } from '../domain/verdict-logic';

// La lógica de decisión vive en domain/ (pura, testeable sin base de datos).
export { applyVerdict, verdictKey } from '../domain/verdict-logic';
export type { Verdict, VerdictKind, VerdictScope } from '../domain/verdict-logic';

/**
 * Veredictos humanos: la memoria del validador.
 *
 * Cuando alguien revisa un caso en la app y da el visto bueno, queda escrito
 * aquí y el motor no lo vuelve a marcar. Es lo que evita que la bandeja de
 * revisión se llene cada día con los mismos casos ya resueltos.
 *
 * El veredicto está atado al `source_fingerprint` del documento: si compras lo
 * edita en AdminPAQ (cambia unidad, folio, monto o productos), la huella deja
 * de coincidir y el veredicto caduca solo. Un "aprobado" no puede tapar para
 * siempre un documento que después se convirtió en otra cosa.
 */

export interface CreateVerdictInput {
  documentId: number;
  folioPid: string | null;
  verdict: VerdictKind;
  correctedToPid?: string | null;
  scope?: VerdictScope;
  ruleCodes?: RuleCode[];
  reason: string;
  reviewedBy: string;
  sourceFingerprint: string;
}

interface VerdictRow {
  id: string;
  document_id: number;
  folio_pid: string | null;
  verdict: VerdictKind;
  corrected_to_pid: string | null;
  scope: VerdictScope;
  rule_codes: string[];
  reason: string;
  reviewed_by: string;
  reviewed_at: Date;
  source_fingerprint: string;
}

function toVerdict(row: VerdictRow): Verdict {
  return {
    id: Number(row.id),
    documentId: row.document_id,
    folioPid: row.folio_pid,
    verdict: row.verdict,
    correctedToPid: row.corrected_to_pid,
    scope: row.scope,
    ruleCodes: (row.rule_codes ?? []) as RuleCode[],
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    sourceFingerprint: row.source_fingerprint,
  };
}

/**
 * Registra un veredicto.
 *
 * Si ya existía uno para el mismo par (documento, folio), se desactiva: la
 * decisión más reciente manda, pero el historial se conserva para auditoría.
 */
export async function recordVerdict(input: CreateVerdictInput): Promise<Verdict> {
  return validatorDb.begin(async (tx) => {
    await tx`
      UPDATE review_verdicts
      SET active = 0
      WHERE active = 1
        AND document_id = ${input.documentId}
        AND folio_pid IS NOT DISTINCT FROM ${input.folioPid ?? null}
    `;

    const [row] = await tx<VerdictRow[]>`
      INSERT INTO review_verdicts (
        document_id, folio_pid, verdict, corrected_to_pid, scope,
        rule_codes, reason, reviewed_by, source_fingerprint
      ) VALUES (
        ${input.documentId},
        ${input.folioPid ?? null},
        ${input.verdict},
        ${input.correctedToPid ?? null},
        ${input.scope ?? 'this_pair'},
        ${input.ruleCodes ?? []},
        ${input.reason},
        ${input.reviewedBy},
        ${input.sourceFingerprint}
      )
      RETURNING *
    `;

    // Las anomalías del par quedan resueltas por esta decisión.
    await tx`
      UPDATE anomalies
      SET resolved_at = NOW()
      WHERE active = 1
        AND resolved_at IS NULL
        AND document_id = ${input.documentId}
        AND folio_pid IS NOT DISTINCT FROM ${input.folioPid ?? null}
    `;

    return toVerdict(row);
  });
}

/**
 * Veredictos vigentes para un conjunto de documentos.
 *
 * Solo devuelve los que siguen siendo válidos: el fingerprint debe coincidir
 * con el estado actual del documento. Los caducos se ignoran (y el caso vuelve
 * a evaluarse como nuevo).
 */
export async function fetchActiveVerdicts(
  documentIds: number[],
  fingerprintByDocument: Map<number, string>,
): Promise<Map<string, Verdict>> {
  const result = new Map<string, Verdict>();
  if (documentIds.length === 0) return result;

  const rows = await validatorDb<VerdictRow[]>`
    SELECT *
    FROM review_verdicts
    WHERE active = 1 AND document_id = ANY(${documentIds})
  `;

  for (const row of rows) {
    const current = fingerprintByDocument.get(row.document_id);

    // El documento cambió en el ERP desde que se decidió: el veredicto caducó.
    if (!current || current !== row.source_fingerprint) continue;

    const verdict = toVerdict(row);
    result.set(verdictKey(verdict.documentId, verdict.folioPid), verdict);
  }

  return result;
}

/** Veredictos de alcance `rule_for_folio` que perdonan reglas en un folio completo. */
export async function fetchFolioRuleExemptions(
  pids: string[],
): Promise<Map<string, Set<RuleCode>>> {
  const result = new Map<string, Set<RuleCode>>();
  if (pids.length === 0) return result;

  const rows = await validatorDb<{ folio_pid: string; rule_codes: string[] }[]>`
    SELECT folio_pid, rule_codes
    FROM review_verdicts
    WHERE active = 1
      AND scope = 'rule_for_folio'
      AND folio_pid = ANY(${pids})
  `;

  for (const row of rows) {
    const set = result.get(row.folio_pid) ?? new Set<RuleCode>();
    for (const code of row.rule_codes ?? []) set.add(code as RuleCode);
    result.set(row.folio_pid, set);
  }

  return result;
}
