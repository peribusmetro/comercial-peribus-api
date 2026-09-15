import { describe, it, expect } from 'vitest';
import { applyVerdict, verdictKey, type Verdict } from './verdict-logic';

/**
 * Tests de la lógica de decisión de veredictos.
 *
 * `applyVerdict` es pura: recibe el mapa de veredictos vigentes y decide qué
 * hacer con un par (documento, folio). El filtrado por fingerprint ocurre
 * antes, en fetchActiveVerdicts.
 */

function verdict(partial: Partial<Verdict> = {}): Verdict {
  return {
    id: 1,
    documentId: 52853,
    folioPid: 'M-260723-67',
    verdict: 'approved',
    correctedToPid: null,
    scope: 'this_pair',
    ruleCodes: [],
    reason: 'Revisado con compras',
    reviewedBy: 'sistemas',
    reviewedAt: new Date(),
    sourceFingerprint: 'abc123',
    ...partial,
  };
}

function mapOf(...verdicts: Verdict[]): Map<string, Verdict> {
  const map = new Map<string, Verdict>();
  for (const v of verdicts) map.set(verdictKey(v.documentId, v.folioPid), v);
  return map;
}

describe('applyVerdict', () => {
  it('evalúa normalmente cuando no hay veredicto', () => {
    const r = applyVerdict(52853, 'M-260723-67', new Map());
    expect(r.decision).toBe('evaluate');
    expect(r.forgivenRules.size).toBe(0);
  });

  it('liga cuando el par fue aprobado', () => {
    const r = applyVerdict(52853, 'M-260723-67', mapOf(verdict({ verdict: 'approved' })));
    expect(r.decision).toBe('link');
  });

  it('omite cuando el par fue rechazado', () => {
    const r = applyVerdict(52853, 'M-260723-67', mapOf(verdict({ verdict: 'rejected' })));
    expect(r.decision).toBe('skip');
  });

  it('no aplica un veredicto de otro folio', () => {
    const r = applyVerdict(52853, 'M-OTRO-99', mapOf(verdict({ folioPid: 'M-260723-67' })));
    expect(r.decision).toBe('evaluate');
  });

  it('un veredicto de alcance documento aplica a cualquier folio', () => {
    const wide = verdict({ folioPid: null, scope: 'document', verdict: 'rejected' });
    const r = applyVerdict(52853, 'M-CUALQUIERA', mapOf(wide));
    expect(r.decision).toBe('skip');
  });

  describe('corrected', () => {
    it('omite el folio equivocado', () => {
      const corrected = verdict({
        verdict: 'corrected',
        folioPid: 'M-260723-67',
        correctedToPid: 'M-260601-38',
      });
      const r = applyVerdict(52853, 'M-260723-67', mapOf(corrected));
      expect(r.decision).toBe('skip');
    });

    it('liga en el folio correcto', () => {
      const corrected = verdict({
        verdict: 'corrected',
        folioPid: 'M-260601-38',
        correctedToPid: 'M-260601-38',
      });
      const r = applyVerdict(52853, 'M-260601-38', mapOf(corrected));
      expect(r.decision).toBe('link');
    });
  });

  describe('rule_for_folio', () => {
    it('perdona las reglas indicadas y sigue evaluando el resto', () => {
      const exemption = verdict({
        scope: 'rule_for_folio',
        ruleCodes: ['R6_DUPLICATE_MAJOR_PART'],
      });
      const r = applyVerdict(52853, 'M-260723-67', mapOf(exemption));

      // No decide por sí solo: solo exime una regla.
      expect(r.decision).toBe('evaluate');
      expect(r.forgivenRules.has('R6_DUPLICATE_MAJOR_PART')).toBe(true);
      expect(r.forgivenRules.has('R1_UNIT_MISMATCH')).toBe(false);
    });
  });
});

describe('verdictKey', () => {
  it('distingue folios distintos del mismo documento', () => {
    expect(verdictKey(1, 'M-A')).not.toBe(verdictKey(1, 'M-B'));
  });

  it('usa un comodín para el alcance de documento', () => {
    expect(verdictKey(1, null)).toBe('1::*');
  });
});
