import { validatorDb } from '@/db/clients';
import { env } from '@/config/env';
import { extractFolios } from '@/domain/normalize';
import { computeFingerprint, evaluateDocument, type MajorPartGroup } from '@/domain/rules';
import type { DetectedAnomaly, RuleCode, StagedDocument } from '@/domain/types';
import {
  fetchExistingLinks,
  fetchFolioPartTallies,
  resolveMaintenanceFolios,
} from './folio-resolver';
import { applyVerdict, fetchActiveVerdicts, fetchFolioRuleExemptions } from './verdicts';
import type { LinkToApply } from './link-applier';

/**
 * Orquestador de la validación.
 *
 * Toma los documentos en staging, resuelve sus folios candidatos, aplica los
 * veredictos humanos vigentes, corre el motor de reglas y decide qué ligar y
 * qué retener.
 *
 * En modo `audit` no escribe links: solo registra anomalías. Es el modo con
 * el que arranca el sistema, para medir el problema sin alterar los reportes
 * que ya circulan.
 */

export interface ValidationSummary {
  documentsEvaluated: number;
  pairsEvaluated: number;
  /** Anomalías nuevas escritas (las repetidas con igual huella no se recuentan). */
  anomaliesPersisted: number;
  /** Anomalías detectadas en esta corrida, incluidas las ya conocidas. */
  anomaliesDetected: number;
  quarantined: number;
  flagged: number;
  /** Pares que pueden ligarse: por reglas limpias o por veredicto aprobado. */
  linkable: number;
  /** Pares omitidos porque un humano los rechazó o los mandó a otro folio. */
  skippedByVerdict: number;
  /** Pares ligados por decisión humana previa, sin volver a evaluar reglas. */
  linkedByVerdict: number;
  foliosNotFound: number;
  byRule: Record<string, number>;
  /** Solo en modo enforce. */
  linksApplied?: number;
  linkErrors?: string[];
}

export interface ValidationOptions {
  /** Límite de documentos a evaluar (para correr por lotes). */
  limit?: number;
  /** Evaluar solo documentos sincronizados en las últimas N horas. */
  sinceHours?: number;
  /** Fuerza el modo, ignorando VALIDATOR_MODE. */
  mode?: 'audit' | 'enforce';
  runId?: number;
}

interface RuleConfigRow {
  code: string;
  enabled: boolean;
}

/** Reglas desactivadas desde la tabla de configuración. */
async function fetchDisabledRules(): Promise<Set<RuleCode>> {
  const rows = await validatorDb<RuleConfigRow[]>`
    SELECT code, enabled FROM validation_rules
  `;
  return new Set(
    rows.filter((r) => !r.enabled).map((r) => r.code as RuleCode),
  );
}

/** Grupos de piezas mayores configurados (R6). */
export async function fetchMajorPartGroups(): Promise<MajorPartGroup[]> {
  const rows = await validatorDb<
    { group_code: string; group_name: string; max_per_folio: number; product_code: string }[]
  >`
    SELECT g.group_code, g.group_name, g.max_per_folio, m.product_code
    FROM major_part_groups g
    JOIN major_part_members m ON m.group_id = g.id
    WHERE g.enabled = TRUE
  `;

  const byCode = new Map<string, MajorPartGroup>();

  for (const row of rows) {
    const existing = byCode.get(row.group_code);
    if (existing) {
      existing.productCodes.add(row.product_code.toUpperCase());
      continue;
    }
    byCode.set(row.group_code, {
      groupCode: row.group_code,
      groupName: row.group_name,
      maxPerFolio: row.max_per_folio,
      productCodes: new Set([row.product_code.toUpperCase()]),
    });
  }

  return [...byCode.values()];
}

/** Documentos de staging listos para evaluar, con sus movimientos. */
async function loadStagedDocuments(options: ValidationOptions): Promise<StagedDocument[]> {
  const limit = options.limit ?? 5000;

  const docs = await validatorDb<
    {
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
    }[]
  >`
    SELECT
      d.document_id, d.document_concept_id, c.concept_name, d.document_series,
      d.folio, d.date, d.business_name, d.rfc, d.nature, d.cancelled, d.total,
      d.extra_text_one, d.extra_text_two, d.extra_text_three, d.sql_timestamp_parsed
    FROM adm_documents d
    LEFT JOIN adm_concepts c ON c.concept_id = d.document_concept_id
    WHERE d.active = 1
      AND d.cancelled = 0
      AND d.extra_text_three IS NOT NULL
      AND TRIM(d.extra_text_three) <> ''
      ${
        options.sinceHours
          ? validatorDb`AND d.synced_at >= NOW() - (${options.sinceHours} * INTERVAL '1 hour')`
          : validatorDb``
      }
    ORDER BY d.date DESC NULLS LAST
    LIMIT ${limit}
  `;

  if (docs.length === 0) return [];

  const ids = docs.map((d) => d.document_id);

  const movements = await validatorDb<
    {
      movement_id: number;
      document_id: number;
      product_id: number | null;
      product_code: string | null;
      product_name: string | null;
      units: number | null;
      price: number | null;
      total: number | null;
      extra_text_one: string | null;
    }[]
  >`
    SELECT
      mv.movement_id, mv.document_id, mv.product_id,
      p.product_code, p.product_name,
      mv.units, mv.price, mv.total, mv.extra_text_one
    FROM adm_movements mv
    LEFT JOIN adm_products p ON p.product_id = mv.product_id
    WHERE mv.active = 1 AND mv.document_id = ANY(${ids})
  `;

  const byDocument = new Map<number, StagedDocument['movements']>();
  for (const mv of movements) {
    const list = byDocument.get(mv.document_id) ?? [];
    list.push(mv);
    byDocument.set(mv.document_id, list);
  }

  return docs.map((d) => ({ ...d, movements: byDocument.get(d.document_id) ?? [] }));
}

/** Persiste las anomalías detectadas, sin duplicar las ya registradas. */
async function persistAnomalies(
  anomalies: (DetectedAnomaly & { fingerprint: string })[],
  runId: number | null,
): Promise<number> {
  if (anomalies.length === 0) return 0;

  const rows = anomalies.map((a) => ({
    run_id: runId,
    document_id: a.documentId,
    folio_pid: a.folioPid,
    rule_code: a.ruleCode,
    severity: a.severity,
    detail: a.detail,
    evidence: JSON.stringify(a.evidence),
    outcome: a.action === 'quarantine' ? 'quarantined' : 'flagged',
    source_fingerprint: a.fingerprint,
  }));

  let written = 0;
  const CHUNK = 500;

  // La deduplicación usa dos índices parciales (ver migración 003) porque en
  // Postgres un NULL nunca colisiona en un índice único: sin separarlos, una
  // anomalía sin folio se duplicaría en cada corrida. Por eso los lotes se
  // separan según tengan folio o no.
  const withFolio = rows.filter((r) => r.folio_pid !== null);
  const withoutFolio = rows.filter((r) => r.folio_pid === null);

  for (let i = 0; i < withFolio.length; i += CHUNK) {
    const batch = withFolio.slice(i, i + CHUNK);
    // El fingerprint forma parte de la clave: si el documento cambia en el
    // ERP, se registra una anomalía nueva en vez de pisar la histórica.
    const result = await validatorDb`
      INSERT INTO anomalies ${validatorDb(batch)}
      ON CONFLICT (document_id, folio_pid, rule_code, source_fingerprint)
      WHERE folio_pid IS NOT NULL
      DO NOTHING
    `;
    written += result.count ?? 0;
  }

  for (let i = 0; i < withoutFolio.length; i += CHUNK) {
    const batch = withoutFolio.slice(i, i + CHUNK);
    const result = await validatorDb`
      INSERT INTO anomalies ${validatorDb(batch)}
      ON CONFLICT (document_id, rule_code, source_fingerprint)
      WHERE folio_pid IS NULL
      DO NOTHING
    `;
    written += result.count ?? 0;
  }

  return written;
}

/**
 * Corre la validación completa.
 *
 * El flujo por documento es:
 *   1. calcular fingerprint
 *   2. extraer folios candidatos de extra_text_three
 *   3. resolver cada folio contra la app (¿existe? ¿de qué unidad es?)
 *   4. ¿hay veredicto humano vigente? → respetarlo y seguir
 *   5. correr las reglas
 *   6. registrar anomalías; ligar solo si nada lo impide y el modo es enforce
 */
export async function runValidation(
  options: ValidationOptions = {},
): Promise<ValidationSummary> {
  const mode = options.mode ?? env.VALIDATOR_MODE;

  const summary: ValidationSummary = {
    documentsEvaluated: 0,
    pairsEvaluated: 0,
    anomaliesPersisted: 0,
    anomaliesDetected: 0,
    quarantined: 0,
    flagged: 0,
    linkable: 0,
    skippedByVerdict: 0,
    linkedByVerdict: 0,
    foliosNotFound: 0,
    byRule: {},
  };

  const documents = await loadStagedDocuments(options);
  if (documents.length === 0) return summary;

  summary.documentsEvaluated = documents.length;

  const [disabledRules, majorPartGroups] = await Promise.all([
    fetchDisabledRules(),
    fetchMajorPartGroups(),
  ]);

  // Huella actual de cada documento: define qué veredictos siguen vigentes.
  const fingerprints = new Map<number, string>();
  for (const doc of documents) {
    fingerprints.set(doc.document_id, computeFingerprint(doc));
  }

  // Folios candidatos de todo el lote, resueltos de una sola vez.
  const candidatePids = new Set<string>();
  const candidatesByDocument = new Map<number, string[]>();

  for (const doc of documents) {
    const extraction = extractFolios(doc.extra_text_three);
    const pids = extraction.candidates
      .filter((c) => c.kind === 'maintenance')
      .map((c) => c.pid);

    candidatesByDocument.set(doc.document_id, pids);
    for (const pid of pids) candidatePids.add(pid);
  }

  const documentIds = documents.map((d) => d.document_id);
  const productCodesByGroup = new Map(
    majorPartGroups.map((g) => [g.groupCode, g.productCodes]),
  );

  const [folioLookup, verdicts, exemptions, tallies, existingLinks] = await Promise.all([
    resolveMaintenanceFolios([...candidatePids]),
    fetchActiveVerdicts(documentIds, fingerprints),
    fetchFolioRuleExemptions([...candidatePids]),
    fetchFolioPartTallies([...candidatePids], productCodesByGroup),
    fetchExistingLinks(documentIds),
  ]);

  summary.foliosNotFound = folioLookup.missing.length;

  const pendingAnomalies: (DetectedAnomaly & { fingerprint: string })[] = [];
  const linkable: LinkToApply[] = [];

  for (const doc of documents) {
    const fingerprint = fingerprints.get(doc.document_id)!;
    const pids = candidatesByDocument.get(doc.document_id) ?? [];

    for (const pid of pids) {
      const folio = folioLookup.found.get(pid);
      if (!folio) continue; // el folio no existe en la app: nada que validar

      summary.pairsEvaluated++;

      // Ya está ligado: no se re-propone.
      if (existingLinks.get(doc.document_id)?.has(pid)) continue;

      // ¿Hay decisión humana vigente para este par?
      const decision = applyVerdict(doc.document_id, pid, verdicts);

      if (decision.decision === 'skip') {
        summary.skippedByVerdict++;
        continue;
      }

      if (decision.decision === 'link') {
        // Aprobado por un humano: se liga sin volver a evaluar reglas.
        // Cuenta como `linkable` (se va a ligar), no como omitido.
        summary.linkedByVerdict++;
        summary.linkable++;
        linkable.push({
          documentId: doc.document_id,
          folioPid: pid,
          entityId: folio.entityId,
          matchMethod: 'manual_verdict',
        });
        continue;
      }

      // Reglas perdonadas: las desactivadas globalmente, más las que un humano
      // eximió para este folio, más las de alcance rule_for_folio del documento.
      const forgiven = new Set<RuleCode>([
        ...disabledRules,
        ...(exemptions.get(pid) ?? []),
        ...decision.forgivenRules,
      ]);

      const { anomalies, shouldLink } = evaluateDocument(doc, folio, {
        majorPartGroups,
        folioTally: tallies.get(pid) ?? {},
        disabledRules: forgiven,
        lateRelinkDays: env.LATE_RELINK_DAYS,
      });

      for (const anomaly of anomalies) {
        pendingAnomalies.push({ ...anomaly, fingerprint });
        summary.anomaliesDetected++;
        summary.byRule[anomaly.ruleCode] = (summary.byRule[anomaly.ruleCode] ?? 0) + 1;
        if (anomaly.action === 'quarantine') summary.quarantined++;
        else summary.flagged++;
      }

      if (shouldLink) {
        summary.linkable++;
        linkable.push({ documentId: doc.document_id, folioPid: pid, entityId: folio.entityId });
      }
    }
  }

  // persistAnomalies devuelve filas NUEVAS: las ya registradas con la misma
  // huella no se recuentan (ON CONFLICT DO NOTHING). Por eso se guarda aparte
  // de anomaliesDetected, que sí cuenta todo lo visto en esta corrida.
  summary.anomaliesPersisted = await persistAnomalies(pendingAnomalies, options.runId ?? null);

  // En modo auditoría se reporta y no se toca nada más.
  if (mode === 'enforce' && linkable.length > 0) {
    const { applyLinks } = await import('./link-applier');
    const applied = await applyLinks(linkable, options.runId ?? null);

    summary.linksApplied = applied.applied;
    summary.linkErrors = applied.errors;

    // Un fallo del aplicador NO puede pasar como corrida exitosa: sin esto,
    // enforce podría no ligar nada durante semanas sin ninguna señal.
    for (const error of applied.errors) {
      console.error('applyLinks:', error);
    }

    if (applied.errors.length > 0 && applied.applied === 0) {
      throw new Error(
        `El aplicador de links falló por completo (${applied.attempted} intentos): ${applied.errors[0]}`,
      );
    }
  }

  return summary;
}
