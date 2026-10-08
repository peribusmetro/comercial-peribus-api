import { Router } from 'express';
import { z } from 'zod';
import { validatorDb } from '../../db/clients';
import {
  finishRun,
  runSyncStep,
  startRun,
  stepSummary,
  type SyncStep,
} from '../../etl/sync';
import { closeSqlServerPool } from '../../etl/sqlserver';
import { runPublish } from '../../services/publisher';
import { runValidation } from '../../services/validator';
import { env } from '../../config/env';
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

const stepSchema = z.enum([
  'ingest',
  'documents',
  'movements',
  'catalogs',
  'validate',
  'publish',
]);
type Step = z.infer<typeof stepSchema>;

/** Minutos tras los cuales una corrida 'running' se considera abandonada. */
const STALE_RUN_MINUTES = 30;

/**
 * Evita que dos corridas del mismo paso se pisen.
 *
 * Antes de decidir, cierra las corridas abandonadas: si la lambda murió a
 * media corrida, la fila queda en 'running' para siempre y bloquearía el paso
 * indefinidamente. Marcarlas como fallidas las vuelve visibles en el historial
 * y libera el paso para el siguiente intento.
 */
async function hasRunningStep(step: string): Promise<boolean> {
  await validatorDb`
    UPDATE sync_runs
    SET status        = 'failed',
        finished_at   = NOW(),
        error_message = 'Corrida abandonada: sin señales de avance. Probable corte del proceso.'
    WHERE step = ${step}
      AND status = 'running'
      AND started_at < NOW() - (${STALE_RUN_MINUTES} * INTERVAL '1 minute')
  `;

  const rows = await validatorDb<{ id: string }[]>`
    SELECT id FROM sync_runs
    WHERE step = ${step} AND status = 'running'
    LIMIT 1
  `;

  return rows.length > 0;
}

/**
 * Mantiene viva la lambda mientras el trabajo en segundo plano termina.
 *
 * En Vercel la función se congela al enviar la respuesta: sin `waitUntil`, un
 * ETL largo se cortaría a media corrida y dejaría `sync_runs` en 'running'
 * para siempre, bloqueando el paso durante la siguiente hora.
 *
 * Fuera de Vercel el import no existe y se sigue de largo (el proceso local
 * no se congela).
 */
function keepAlive(promise: Promise<unknown>): void {
  try {
    // Import diferido: en local `@vercel/functions` puede no estar disponible
    // y no debe romper el arranque.
    const { waitUntil } = require('@vercel/functions') as {
      waitUntil?: (p: Promise<unknown>) => void;
    };
    waitUntil?.(promise);
  } catch {
    // Entorno no-Vercel: el proceso sigue vivo por su cuenta.
  }
}

interface RunRequest {
  full: boolean;
  tables?: string[];
}

/** Ejecuta el paso en segundo plano y deja el resultado en sync_runs. */
function executeInBackground(
  step: Step,
  runId: number,
  request: RunRequest,
): void {
  const work = (async () => {
    try {
      if (step === 'publish') {
        const summary = await runPublish({ runId, tables: request.tables });
        await finishRun(runId, {
          status: summary.errors > 0 ? 'failed' : 'success',
          rowsWritten: summary.tables.reduce(
            (n, t) => n + t.inserted + t.updated + t.deactivated,
            0,
          ),
          errorMessage:
            summary.errors > 0
              ? `${summary.errors} fila(s) con error`
              : undefined,
          summary: summary as unknown as Record<string, unknown>,
        });
      } else if (step === 'validate') {
        const summary = await runValidation({ runId });
        await finishRun(runId, {
          status: 'success',
          rowsRead: summary.documentsEvaluated,
          anomaliesFound: summary.anomaliesDetected,
          summary: summary as unknown as Record<string, unknown>,
        });
      } else {
        const result = await runSyncStep(step as SyncStep, {
          full: request.full,
          tables: request.tables,
        });
        await finishRun(runId, {
          // Un paso con filas en error no cuenta como éxito: la alerta de las
          // 06:00 se apoya en este estado.
          status: result.errors > 0 ? 'failed' : 'success',
          rowsRead: result.rowsRead,
          rowsWritten: result.rowsWritten,
          errorMessage:
            result.errors > 0
              ? `${result.errors} fila(s) con error`
              : undefined,
          summary: stepSummary(result),
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
      if (step !== 'validate' && step !== 'publish') {
        await closeSqlServerPool().catch(() => undefined);
      }
    }
  })();

  keepAlive(work);
}

// ---------------------------------------------------------------------------
// POST /internal/run?step=...&full=true&tables=admConceptos,admAlmacenes
// ---------------------------------------------------------------------------

const tablesSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  )
  .optional();

internalRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = stepSchema.safeParse(req.query.step ?? body.step);

    if (!parsed.success) {
      res.status(400).json({
        error: 'step inválido',
        valid: stepSchema.options,
      });
      return;
    }

    const step = parsed.data;
    const full = req.query.full === 'true' || body.full === true;

    const tablesRaw = req.query.tables ?? body.tables;
    const tablesParsed = tablesSchema.safeParse(
      typeof tablesRaw === 'string'
        ? tablesRaw
        : Array.isArray(tablesRaw)
          ? tablesRaw.join(',')
          : undefined,
    );
    if (
      !tablesParsed.success ||
      (tablesParsed.data && step !== 'ingest' && step !== 'publish')
    ) {
      res.status(400).json({
        error:
          'tables solo aplica a step=ingest o step=publish, separadas por coma',
      });
      return;
    }

    if (await hasRunningStep(step)) {
      res.status(409).json({
        error: `Ya hay una corrida de "${step}" en proceso`,
        hint: 'Consulta GET /anomalies/runs para ver su estado',
      });
      return;
    }

    const runId = await startRun(
      step,
      step === 'validate' ? env.VALIDATOR_MODE : undefined,
    );

    executeInBackground(step, runId, { full, tables: tablesParsed.data });

    // 202: aceptado y en proceso. El cron no espera el resultado.
    res.status(202).json({
      accepted: true,
      step,
      runId,
      full: step === 'validate' ? undefined : full,
      tables: tablesParsed.data,
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
