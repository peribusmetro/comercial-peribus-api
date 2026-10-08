import { validatorDb } from '../db/clients';
import {
  ingestTables,
  summarizeIngest,
  type IngestOptions,
  type TableIngestResult,
} from './ingest';

/**
 * Pasos del ETL y control de corridas (sync_runs).
 *
 * Desde la migración 004 la ingesta es genérica (`ingest.ts`, 9 tablas).
 * Los pasos históricos `documents` / `movements` / `catalogs` se conservan
 * como subconjuntos para no romper el cron ni la CLI; el paso `ingest` corre
 * las 9 tablas de una vez, que es lo que agenda el cron nuevo.
 */

export type SyncStep = 'ingest' | 'documents' | 'movements' | 'catalogs';

export const SYNC_STEPS: readonly SyncStep[] = [
  'ingest',
  'documents',
  'movements',
  'catalogs',
];

/** Qué tablas corre cada paso. `ingest` = todas. */
const STEP_TABLES: Record<Exclude<SyncStep, 'ingest'>, readonly string[]> = {
  documents: ['admDocumentos'],
  movements: ['admMovimientos'],
  catalogs: ['admProductos', 'admConceptos'],
};

export interface StepResult {
  step: SyncStep;
  rowsRead: number;
  rowsWritten: number;
  errors: number;
  elapsedMs: number;
  details: {
    tables: TableIngestResult[];
    full: boolean;
    requested?: readonly string[];
  };
}

/** Abre una corrida en sync_runs y devuelve su id. */
export async function startRun(step: string, mode?: string): Promise<number> {
  const [row] = await validatorDb<{ id: string }[]>`
    INSERT INTO sync_runs (step, status, mode)
    VALUES (${step}, 'running', ${mode ?? null})
    RETURNING id
  `;
  return Number(row.id);
}

export async function finishRun(
  runId: number,
  outcome: {
    status: 'success' | 'failed';
    rowsRead?: number;
    rowsWritten?: number;
    anomaliesFound?: number;
    errorMessage?: string;
    summary?: Record<string, unknown>;
  },
): Promise<void> {
  await validatorDb`
    UPDATE sync_runs SET
      status          = ${outcome.status},
      finished_at     = NOW(),
      rows_read       = ${outcome.rowsRead ?? 0},
      rows_written    = ${outcome.rowsWritten ?? 0},
      anomalies_found = ${outcome.anomaliesFound ?? 0},
      error_message   = ${outcome.errorMessage ?? null},
      summary         = ${outcome.summary ? JSON.stringify(outcome.summary) : null}::jsonb
    WHERE id = ${runId}
  `;
}

export interface RunStepOptions extends IngestOptions {
  /** Solo para `ingest`: limitar a estas tablas (nombres ERP, staging o app). */
  tables?: readonly string[];
}

/** Ejecuta un paso del ETL y devuelve su resultado (no toca sync_runs). */
export async function runSyncStep(
  step: SyncStep,
  options: RunStepOptions = {},
): Promise<StepResult> {
  const startedAt = Date.now();
  const requested = step === 'ingest' ? options.tables : STEP_TABLES[step];
  const results = await ingestTables(requested, options);
  const summary = summarizeIngest(results);

  return {
    step,
    rowsRead: summary.rowsRead,
    rowsWritten: summary.rowsWritten,
    errors: summary.errors,
    elapsedMs: Date.now() - startedAt,
    details: { tables: summary.tables, full: options.full ?? false, requested },
  };
}

/** Resumen apto para sync_runs.summary (JSON). */
export function stepSummary(result: StepResult): Record<string, unknown> {
  return {
    full: result.details.full,
    requested: result.details.requested ?? null,
    errors: result.errors,
    tables: result.details.tables.map((t) => ({
      table: t.table,
      erp_ids: t.erpIds,
      missing: t.missing,
      modified: t.modified,
      drifted: t.drifted,
      refreshed_by_parent: t.refreshedByParent,
      inserted: t.inserted,
      updated: t.updated,
      changed: t.changed,
      deactivated: t.deactivated,
      errors: t.errors,
      elapsed_ms: t.elapsedMs,
    })),
  };
}
