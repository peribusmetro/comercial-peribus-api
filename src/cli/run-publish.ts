import { closeConnections } from '../db/clients';
import { finishRun, startRun } from '../etl/sync';
import { runPublish, type PublishSummary } from '../services/publisher';

/**
 * Publica staging → app desde la terminal.
 *
 *   npm run publish -- --dry-run                 (calcula y reporta, no escribe)
 *   npm run publish                              (las 9 tablas)
 *   npm run publish -- --tables=admConceptos,admAlmacenes
 */

function report(s: PublishSummary): void {
  console.table(
    s.tables.map((t) => ({
      Tabla: t.table,
      Candidatas: t.candidates,
      Insertadas: t.inserted,
      Actualizadas: t.updated,
      Desactivadas: t.deactivated,
      Retenidas: t.held,
      'En silencio': t.silent,
      Errores: t.errors,
      Seg: (t.elapsedMs / 1000).toFixed(1),
    })),
  );
  console.log(
    `\n  documentos retenidos: ${s.heldDocuments} · cambios abiertos: ${s.changesOpened} · ` +
      `actualizados: ${s.changesUpdated} · obsoletos: ${s.changesObsoleted} · errores: ${s.errors}`,
  );
  if (s.dryRun) {
    console.log(
      '  (dry-run: no se escribió nada; "Insertadas" incluye actualizaciones)',
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tablesArg = args
    .find((a) => a.startsWith('--tables='))
    ?.slice('--tables='.length);
  const tables = tablesArg
    ? tablesArg
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Publicación staging → app${dryRun ? '  (DRY-RUN)' : ''}`);
  if (tables) console.log(`  tablas: ${tables.join(', ')}`);
  console.log('═══════════════════════════════════════════════════\n');

  const started = Date.now();
  const runId = dryRun ? null : await startRun('publish');

  try {
    const summary = await runPublish({ tables, dryRun, runId });
    report(summary);
    if (runId !== null) {
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
    }
    if (summary.errors > 0) process.exitCode = 1;
  } catch (err) {
    if (runId !== null) {
      await finishRun(runId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
    throw err;
  }

  console.log(`\nTotal: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main()
  .then(async () => {
    await closeConnections();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(
      '\nPublicación falló:',
      err instanceof Error ? err.message : err,
    );
    await closeConnections().catch(() => undefined);
    process.exit(1);
  });
