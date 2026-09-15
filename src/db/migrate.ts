import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatorDb, closeConnections } from './clients';

/**
 * Runner de migraciones para la DB del validador.
 *
 * Aplica en orden los .sql de ./migrations que aún no estén registrados.
 * Cada archivo corre dentro de una transacción: o entra completo, o no entra.
 */

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await validatorDb`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        VARCHAR(200) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function appliedMigrations(): Promise<Set<string>> {
  const rows = await validatorDb<{ name: string }[]>`SELECT name FROM _migrations`;
  return new Set(rows.map((r) => r.name));
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const done = await appliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No hay migraciones que aplicar.');
    return;
  }

  let applied = 0;

  for (const file of files) {
    if (done.has(file)) {
      console.log(`  ✓ ${file} (ya aplicada)`);
      continue;
    }

    const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

    await validatorDb.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });

    console.log(`  → ${file} aplicada`);
    applied++;
  }

  console.log(
    applied === 0
      ? 'Base al día, nada que aplicar.'
      : `${applied} migración(es) aplicada(s).`,
  );
}

if (require.main === module) {
  runMigrations()
    .then(closeConnections)
    .catch(async (err) => {
      console.error('Error aplicando migraciones:', err);
      await closeConnections();
      process.exit(1);
    });
}
