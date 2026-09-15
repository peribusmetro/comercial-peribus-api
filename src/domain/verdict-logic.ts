import type { RuleCode } from './types';

/**
 * Lógica de decisión de veredictos. Pura, sin acceso a base de datos.
 *
 * Vive en `domain/` y no en `services/` para poder probarla sin levantar
 * conexiones ni exigir variables de entorno. El servicio
 * (`services/verdicts.ts`) se encarga de leer y escribir; aquí solo se decide.
 */

export type VerdictKind = 'approved' | 'rejected' | 'corrected';
export type VerdictScope = 'this_pair' | 'document' | 'rule_for_folio';

export interface Verdict {
  id: number;
  documentId: number;
  folioPid: string | null;
  verdict: VerdictKind;
  correctedToPid: string | null;
  scope: VerdictScope;
  ruleCodes: RuleCode[];
  reason: string;
  reviewedBy: string;
  reviewedAt: Date;
  sourceFingerprint: string;
}

export interface VerdictDecision {
  decision: 'link' | 'skip' | 'evaluate';
  verdict?: Verdict;
  forgivenRules: Set<RuleCode>;
}

/** Clave de búsqueda de un veredicto. `null` = alcance de documento. */
export function verdictKey(documentId: number, folioPid: string | null): string {
  return `${documentId}::${folioPid ?? '*'}`;
}

/**
 * Decide qué hacer con un par (documento, folio) según los veredictos vigentes.
 *
 * Respeta el alcance:
 *   this_pair      → solo ese folio exacto
 *   document       → el documento contra cualquier folio
 *   rule_for_folio → perdona ciertas reglas, pero no decide por sí solo
 */
export function applyVerdict(
  documentId: number,
  folioPid: string | null,
  verdicts: Map<string, Verdict>,
): VerdictDecision {
  const forgiven = new Set<RuleCode>();

  const exact = verdicts.get(verdictKey(documentId, folioPid));
  const documentWide = verdicts.get(verdictKey(documentId, null));

  for (const candidate of [exact, documentWide]) {
    if (!candidate) continue;

    if (candidate.scope === 'document' || candidate.scope === 'this_pair') {
      if (candidate.verdict === 'approved') {
        return { decision: 'link', verdict: candidate, forgivenRules: forgiven };
      }
      if (candidate.verdict === 'rejected') {
        return { decision: 'skip', verdict: candidate, forgivenRules: forgiven };
      }
      if (candidate.verdict === 'corrected') {
        // El humano mandó el documento a otro folio: aquí no va.
        const goesElsewhere = candidate.correctedToPid !== folioPid;
        return {
          decision: goesElsewhere ? 'skip' : 'link',
          verdict: candidate,
          forgivenRules: forgiven,
        };
      }
    }

    if (candidate.scope === 'rule_for_folio') {
      for (const code of candidate.ruleCodes) forgiven.add(code);
    }
  }

  return { decision: 'evaluate', forgivenRules: forgiven };
}
