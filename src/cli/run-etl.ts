import { closeConnections } from '../db/clients';
import { closeSqlServerPool } from '../etl/sqlserver';
import {
  finishRun,
  startRun,
  syncCatalogs,
  syncDocuments,
  syncMovements,
  type StepResult,
  type SyncStep,
} from '../etl/sync';

/**
 * Ejecuta un paso del ETL desde la terminal.
 *
 *   npm run etl documents         (incremental)
 *   npm run etl documents -- --full
 *   npm run etl movements
 *   npm run etl catalogs
 *   npm run etl all
 */

const STEPS: SyncStep[] = ['documents', 'movements', 'catalogs'];

async function runStep(step: SyncStep, full: boolean): Promise<StepResult> {
  const runId = await startRun(step);

  try {
    const result =
      step === 'documents'
        ? await syncDocuments({ full })
        : step === 'movements'
          ? await syncMovements()
          : await syncCatalogs();

    await finishRun(runId, {
      status: 'success',
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      summary: result.details,
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
    `  ✓ ${result.step.padEnd(10)} leídos ${String(result.rowsRead).padStart(7)} · ` +
      `escritos ${String(result.rowsWritten).padStart(7)} · ${seconds}s`,
  );
  if (result.details) {
    console.log(`    ${JSON.stringify(result.details)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const target = args.find((a) => !a.startsWith('--')) ?? 'all';

  const steps: SyncStep[] =
    target === 'all' ? STEPS : STEPS.includes(target as SyncStep) ? [target as SyncStep] : [];

  if (steps.length === 0) {
    console.error(`Paso desconocido: "${target}". Válidos: ${STEPS.join(', ')}, all`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  ETL AdminPAQ → validador${full ? '  (carga completa)' : ''}`);
  console.log('═══════════════════════════════════════════════════\n');

  const started = Date.now();
  for (const step of steps) {
    report(await runStep(step, full));
  }

  console.log(`\nTotal: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main()
  .then(async () => {
    await closeSqlServerPool();
    await closeConnections();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nETL falló:', err instanceof Error ? err.message : err);
    await closeSqlServerPool().catch(() => undefined);
    await closeConnections().catch(() => undefined);
    process.exit(1);
  });
