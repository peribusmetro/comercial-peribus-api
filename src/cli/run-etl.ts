import { closeConnections } from '../db/clients';
import { closeSqlServerPool } from '../etl/sqlserver';
import {
  finishRun,
  runSyncStep,
  startRun,
  stepSummary,
  SYNC_STEPS,
  type StepResult,
  type SyncStep,
} from '../etl/sync';

/**
 * Ejecuta un paso del ETL desde la terminal.
 *
 *   npm run etl ingest                              (las 9 tablas, incremental)
 *   npm run etl ingest -- --full                    (carga inicial / re-sincronización)
 *   npm run etl ingest -- --tables admConceptos,admAlmacenes
 *   npm run etl documents | movements | catalogs    (subconjuntos históricos)
 */

async function runStep(
  step: SyncStep,
  full: boolean,
  tables?: string[],
): Promise<StepResult> {
  const runId = await startRun(step);

  try {
    const result = await runSyncStep(step, { full, tables });

    await finishRun(runId, {
      status: result.errors > 0 ? 'failed' : 'success',
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      errorMessage:
        result.errors > 0 ? `${result.errors} fila(s) con error` : undefined,
      summary: stepSummary(result),
    });

    return result;
  } catch (err) {
    await finishRun(runId, {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function report(result: StepResult): void {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  console.log(
    `  ${result.step}: leídos ${result.rowsRead.toLocaleString('es-MX')} · ` +
      `escritos ${result.rowsWritten.toLocaleString('es-MX')} · ` +
      `errores ${result.errors} · ${seconds}s\n`,
  );
  console.table(
    result.details.tables.map((t) => ({
      Tabla: t.table,
      'IDs ERP': t.erpIds,
      Faltantes: t.missing,
      Modificados: t.modified,
      'Campos libres': t.drifted,
      'Por padre': t.refreshedByParent,
      Insertados: t.inserted,
      Actualizados: t.updated,
      Cambiaron: t.changed,
      Desactivados: t.deactivated,
      Errores: t.errors,
      Seg: (t.elapsedMs / 1000).toFixed(1),
    })),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const tablesArg = args
    .find((a) => a.startsWith('--tables='))
    ?.slice('--tables='.length);
  const tables = tablesArg
    ? tablesArg
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  const target = args.find((a) => !a.startsWith('--')) ?? 'ingest';

  if (!SYNC_STEPS.includes(target as SyncStep)) {
    console.error(
      `Paso desconocido: "${target}". Válidos: ${SYNC_STEPS.join(', ')}`,
    );
    process.exit(1);
  }
  if (tables && target !== 'ingest') {
    console.error('--tables solo aplica al paso ingest.');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  ETL AdminPAQ → validador${full ? '  (carga completa)' : ''}`);
  if (tables) console.log(`  tablas: ${tables.join(', ')}`);
  console.log('═══════════════════════════════════════════════════\n');

  const started = Date.now();
  const result = await runStep(target as SyncStep, full, tables);
  report(result);

  console.log(`\nTotal: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (result.errors > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await closeSqlServerPool();
    await closeConnections();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error('\nETL falló:', err instanceof Error ? err.message : err);
    await closeSqlServerPool().catch(() => undefined);
    await closeConnections().catch(() => undefined);
    process.exit(1);
  });
