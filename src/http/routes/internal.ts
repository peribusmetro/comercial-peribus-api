import { Router } from 'express';
import { z } from 'zod';
import { validatorDb } from '@/db/clients';
import { finishRun, startRun, syncCatalogs, syncDocuments, syncMovements } from '@/etl/sync';
import { closeSqlServerPool } from '@/etl/sqlserver';
import { runValidation } from '@/services/validator';
import { env } from '@/config/env';
import { asyncHandler } from '../middleware';

/**
 * Endpoints internos, disparados por el cron de Supabase (pg_cron + pg_net).
 *
 * IMPORTANTE: pg_net tiene un timeout corto (segundos). Estos endpoints
 * responden 202 de inmediato y siguen trabajando en segundo plano; si
 * esperaran a terminar, el cron los daría por fallidos aunque hubieran
 * corrido bien.
 *
 * El seguimiento de cada corrida se hace por `sync_runs`, no por la respuesta
 * HTTP.
 */

export const internalRouter = Router();

const stepSchema = z.enum(['documents', 'movements', 'catalogs', 'validate']);

/** Evita que dos corridas del mismo paso se pisen. */
async function hasRunningStep(step: string): Promise<boolean> {
  const rows = await validatorDb<{ id: string }[]>`
    SELECT id FROM sync_runs
    WHERE step = ${step}
      AND status = 'running'
      -- Una corrida "running" de hace más de una hora se considera colgada.
      AND started_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Ejecuta el paso en segundo plano y deja el resultado en sync_runs. */
function executeInBackground(step: string, runId: number, full: boolean): void {
  void (async () => {
    try {
      if (step === 'documents') {
        const r = await syncDocuments({ full });
        await finishRun(runId, {
          status: 'success',
          rowsRead: r.rowsRead,
          rowsWritten: r.rowsWritten,
          summary: r.details,
        });
      } else if (step === 'movements') {
        const r = await syncMovements();
        await finishRun(runId, {
          status: 'success',
          rowsRead: r.rowsRead,
          rowsWritten: r.rowsWritten,
          summary: r.details,
        });
      } else if (step === 'catalogs') {
        const r = await syncCatalogs();
        await finishRun(runId, {
          status: 'success',
          rowsRead: r.rowsRead,
          rowsWritten: r.rowsWritten,
          summary: r.details,
        });
      } else {
        const summary = await runValidation({ runId });
        await finishRun(runId, {
          status: 'success',
          rowsRead: summary.documentsEvaluated,
          anomaliesFound: summary.anomaliesDetected,
          summary: summary as unknown as Record<string, unknown>,
        });
      }
    } catch (err) {
      await finishRun(runId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
      console.error(`Paso "${step}" falló:`, err);
    } finally {
      // El pool de SQL Server no debe quedar abierto entre invocaciones
      // serverless; los de Postgres sí se reutilizan.
      if (step !== 'validate') {
        await closeSqlServerPool().catch(() => undefined);
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// POST /internal/run?step=...
// ---------------------------------------------------------------------------

internalRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const parsed = stepSchema.safeParse(req.query.step ?? req.body?.step);

    if (!parsed.success) {
      res.status(400).json({
        error: 'step inválido',
        valid: ['documents', 'movements', 'catalogs', 'validate'],
      });
      return;
    }

    const step = parsed.data;
    const full = req.query.full === 'true' || req.body?.full === true;

    if (await hasRunningStep(step)) {
      res.status(409).json({
        error: `Ya hay una corrida de "${step}" en proceso`,
        hint: 'Consulta GET /anomalies/runs para ver su estado',
      });
      return;
    }

    const runId = await startRun(step, step === 'validate' ? env.VALIDATOR_MODE : undefined);

    executeInBackground(step, runId, full);

    // 202: aceptado y en proceso. El cron no espera el resultado.
    res.status(202).json({
      accepted: true,
      step,
      runId,
      mode: step === 'validate' ? env.VALIDATOR_MODE : undefined,
      track: `/anomalies/runs`,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /internal/status — estado de la última corrida de cada paso
// ---------------------------------------------------------------------------

internalRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const rows = await validatorDb`
      SELECT DISTINCT ON (step)
        step, status, mode, started_at, finished_at,
        rows_read, rows_written, anomalies_found, error_message
      FROM sync_runs
      ORDER BY step, started_at DESC
    `;

    res.json({ mode: env.VALIDATOR_MODE, steps: rows });
  }),
);
