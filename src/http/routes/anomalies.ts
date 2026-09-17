import { Router } from 'express';
import { z } from 'zod';
import { validatorDb } from '../../db/clients';
import { asyncHandler } from '../middleware';

/**
 * Consulta de anomalías y estadísticas.
 *
 * Alimenta tanto la vista de detalle en la app como el reporte agregado que
 * se le presenta a compras: cuántos casos hay, de qué tipo y cuánto dinero
 * está involucrado.
 */

export const anomaliesRouter = Router();

// ---------------------------------------------------------------------------
// GET /anomalies/stats — el número para llevar a compras
// ---------------------------------------------------------------------------

anomaliesRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [byRule, byOutcome, totals, topFolios] = await Promise.all([
      validatorDb`
        SELECT
          a.rule_code,
          r.name AS rule_name,
          r.severity,
          COUNT(*)                        AS count,
          COUNT(DISTINCT a.folio_pid)     AS folios,
          COALESCE(SUM(d.total), 0)       AS amount
        FROM anomalies a
        JOIN validation_rules r ON r.code = a.rule_code
        LEFT JOIN adm_documents d ON d.document_id = a.document_id
        WHERE a.active = 1 AND a.resolved_at IS NULL
        GROUP BY a.rule_code, r.name, r.severity
        ORDER BY count DESC
      `,
      validatorDb`
        SELECT outcome, COUNT(*) AS count
        FROM anomalies
        WHERE active = 1 AND resolved_at IS NULL
        GROUP BY outcome
      `,
      validatorDb<
        { total_anomalies: string; affected_folios: string; affected_documents: string; amount_at_risk: string }[]
      >`
        SELECT
          COUNT(*)                                AS total_anomalies,
          COUNT(DISTINCT a.folio_pid)             AS affected_folios,
          COUNT(DISTINCT a.document_id)           AS affected_documents,
          COALESCE(SUM(DISTINCT d.total), 0)      AS amount_at_risk
        FROM anomalies a
        LEFT JOIN adm_documents d ON d.document_id = a.document_id
        WHERE a.active = 1 AND a.resolved_at IS NULL
      `,
      validatorDb`
        SELECT
          a.folio_pid,
          COUNT(*)                   AS anomaly_count,
          COALESCE(SUM(d.total), 0)  AS amount,
          ARRAY_AGG(DISTINCT a.rule_code) AS rules
        FROM anomalies a
        LEFT JOIN adm_documents d ON d.document_id = a.document_id
        WHERE a.active = 1 AND a.resolved_at IS NULL AND a.folio_pid IS NOT NULL
        GROUP BY a.folio_pid
        ORDER BY anomaly_count DESC, amount DESC
        LIMIT 20
      `,
    ]);

    res.json({
      totals: totals[0] ?? {},
      by_rule: byRule,
      by_outcome: byOutcome,
      top_folios: topFolios,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /anomalies/document/:id — banderas de un documento
// ---------------------------------------------------------------------------

anomaliesRouter.get(
  '/document/:id',
  asyncHandler(async (req, res) => {
    const documentId = Number(req.params.id);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      res.status(400).json({ error: 'id inválido' });
      return;
    }

    const rows = await validatorDb`
      SELECT a.*, r.name AS rule_name, r.action
      FROM anomalies a
      JOIN validation_rules r ON r.code = a.rule_code
      WHERE a.active = 1 AND a.document_id = ${documentId}
      ORDER BY a.detected_at DESC
    `;

    res.json({ document_id: documentId, anomalies: rows });
  }),
);

// ---------------------------------------------------------------------------
// GET /anomalies/flags — banderas para el filtro de la tabla de documentos
// ---------------------------------------------------------------------------

const flagsQuery = z.object({
  documentIds: z.string().optional(),
  // NO usar z.coerce.boolean(): aplica Boolean(value), y toda cadena no vacía
  // es truthy — "false" daría true y el filtro quedaría inoperante.
  onlyPending: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/**
 * Devuelve las banderas vigentes por documento, en el formato que necesita la
 * tabla de /dashboard/comercial/documents para pintar la columna "Sospechoso".
 */
anomaliesRouter.get(
  '/flags',
  asyncHandler(async (req, res) => {
    const parsed = flagsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Parámetros inválidos', detail: parsed.error.issues });
      return;
    }

    const ids = parsed.data.documentIds
      ?.split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0);

    if (!ids || ids.length === 0) {
      res.status(400).json({ error: 'documentIds es obligatorio (lista separada por comas)' });
      return;
    }

    if (ids.length > 500) {
      res.status(400).json({ error: 'Máximo 500 documentos por consulta' });
      return;
    }

    const rows = await validatorDb<
      {
        document_id: number;
        rule_codes: string[];
        severities: string[];
        outcomes: string[];
        details: string[];
      }[]
    >`
      SELECT
        document_id,
        ARRAY_AGG(DISTINCT rule_code)  AS rule_codes,
        ARRAY_AGG(DISTINCT severity)   AS severities,
        ARRAY_AGG(DISTINCT outcome)    AS outcomes,
        ARRAY_AGG(detail)              AS details
      FROM anomalies
      WHERE active = 1
        AND document_id = ANY(${ids})
        ${parsed.data.onlyPending ? validatorDb`AND resolved_at IS NULL` : validatorDb``}
      GROUP BY document_id
    `;

    const flags: Record<number, unknown> = {};
    for (const row of rows) {
      flags[row.document_id] = {
        rule_codes: row.rule_codes,
        // La severidad más alta define cómo se pinta la fila.
        severity: row.severities.includes('high')
          ? 'high'
          : row.severities.includes('medium')
            ? 'medium'
            : 'low',
        quarantined: row.outcomes.includes('quarantined'),
        details: row.details,
      };
    }

    res.json({ flags });
  }),
);

// ---------------------------------------------------------------------------
// GET /anomalies/runs — historial de corridas
// ---------------------------------------------------------------------------

anomaliesRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const rows = await validatorDb`
      SELECT *
      FROM sync_runs
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;

    res.json({ runs: rows });
  }),
);
