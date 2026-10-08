import { validatorDb } from '../db/clients';
import {
  buildRaw,
  chunk,
  findDriftedIds,
  hashRaw,
  normalizeValue,
  partitionIds,
  type NormalizedRow,
  type StagingState,
} from './ingest-logic';
import {
  fetchAllRows,
  fetchDriftColumns,
  fetchIds,
  fetchRowsModifiedSince,
  fetchRowsWhereIn,
} from './sqlserver';
import { resolveTables, type RawRow, type TableDef } from './tables';

/**
 * Ingesta AdminPAQ → staging del validador, para las 9 tablas del registro.
 *
 * Misma estrategia para todas, por tabla:
 *   1. ids del ERP vs ids de staging → faltantes se traen, borrados se marcan
 *   2. si la tabla tiene CTIMESTAMP → filas modificadas desde el último conocido
 *   3. si tiene campos libres sin CTIMESTAMP → se comparan y se refrescan
 *   4. si tiene tabla padre → se refrescan las hijas de los padres que cambiaron
 *
 * Cada fila se guarda completa en `raw` con su `source_hash`. El upsert solo
 * mueve `source_changed_at` cuando la huella cambia: es la señal que después
 * usa la publicación para saber qué llevar a la app.
 *
 * Idempotente: correrla dos veces no duplica ni corrompe.
 */

const UPSERT_BATCH = 500;

export interface TableIngestResult {
  table: string;
  erpIds: number;
  /** Ids que había que traer (faltantes, sin raw o resucitados). */
  missing: number;
  /** Filas re-leídas por CTIMESTAMP. */
  modified: number;
  /** Filas re-leídas porque un campo libre cambió sin CTIMESTAMP. */
  drifted: number;
  /** Filas re-leídas porque su padre cambió. */
  refreshedByParent: number;
  inserted: number;
  updated: number;
  /** Filas cuya huella cambió (incluye las insertadas). */
  changed: number;
  deactivated: number;
  errors: number;
  elapsedMs: number;
}

export interface IngestOptions {
  /** Trae TODAS las filas del ERP (carga inicial o re-sincronización). */
  full?: boolean;
  /** Si no se corre la tabla padre en la misma corrida, ventana para refrescar hijas. */
  parentWindowHours?: number;
}

interface UpsertOutcome {
  inserted: number;
  updated: number;
  changed: number;
  errors: number;
  changedIds: number[];
}

/** Estado actual de staging: id, borrado, hidratado (tiene raw). */
async function loadStagingState(def: TableDef): Promise<StagingState[]> {
  const rows = await validatorDb.unsafe<
    { id: number; deleted: boolean; hydrated: boolean }[]
  >(
    `SELECT ${def.key} AS id,
            (deleted_at IS NOT NULL) AS deleted,
            (source_hash IS NOT NULL) AS hydrated
     FROM ${def.staging}`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deleted: r.deleted,
    hydrated: r.hydrated,
  }));
}

/**
 * Último CTIMESTAMP conocido en staging.
 *
 * Es texto MM/DD/YYYY: un MAX() directo compara alfabéticamente y devuelve el
 * mes más alto, no la fecha más reciente. Se ordena por la fecha convertida.
 */
async function lastKnownTimestamp(def: TableDef): Promise<string | null> {
  const rows = await validatorDb.unsafe<{ ts: string | null }[]>(
    `SELECT sql_timestamp AS ts
     FROM ${def.staging}
     WHERE sql_timestamp IS NOT NULL
       AND sql_timestamp <> ''
       AND sql_timestamp <> '12/30/1899 00:00:00:000'
       AND sql_timestamp ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}'
     ORDER BY TO_TIMESTAMP(SUBSTRING(sql_timestamp FROM 1 FOR 19), 'MM/DD/YYYY HH24:MI:SS') DESC
     LIMIT 1`,
  );
  return rows[0]?.ts ?? null;
}

/** Campos libres actuales en staging, leídos del raw, con el id en la clave ERP. */
async function loadStagingDrift(def: TableDef): Promise<RawRow[]> {
  const cols = def.driftColumns ?? [];
  if (cols.length === 0) return [];
  const select = cols.map((c) => `raw->>'${c}' AS "${c}"`).join(', ');
  return validatorDb.unsafe<RawRow[]>(
    `SELECT ${def.key} AS "${def.erpKey}", ${select}
     FROM ${def.staging}
     WHERE deleted_at IS NULL AND raw IS NOT NULL`,
  );
}

/** Ids del padre que cambiaron en una ventana, cuando el padre no corrió en esta corrida. */
async function parentChangedInWindow(
  parent: TableDef,
  hours: number,
): Promise<number[]> {
  const rows = await validatorDb.unsafe<{ id: number }[]>(
    `SELECT ${parent.key} AS id
     FROM ${parent.staging}
     WHERE source_changed_at >= NOW() - ($1 * INTERVAL '1 hour')`,
    [hours],
  );
  return rows.map((r) => Number(r.id));
}

/** Marca como borradas del ERP las filas que ya no existen allá. */
async function deactivate(def: TableDef, ids: number[]): Promise<number> {
  let total = 0;
  for (const batch of chunk(ids, UPSERT_BATCH)) {
    const result = await validatorDb.unsafe(
      `UPDATE ${def.staging}
       SET deleted_at = NOW(), active = 0, source_changed_at = NOW()
       WHERE ${def.key} = ANY($1::bigint[]) AND deleted_at IS NULL`,
      [batch],
    );
    total += result.count;
  }
  return total;
}

/**
 * Convierte una fila del ERP en la fila de staging: clave, columnas tipadas,
 * `sql_timestamp` (si aplica), `raw` y `source_hash`.
 */
type StagingValue = string | number | boolean | null;
/**
 * `raw` viaja como objeto, NO como texto JSON: el driver serializa a JSON lo
 * que lleva `::jsonb`, y un texto ya serializado acabaría guardado como
 * escalar (una cadena) en vez de como objeto consultable con `->>`.
 */
type StagingRow = Record<string, StagingValue | NormalizedRow>;

function toStagingRow(def: TableDef, row: RawRow): StagingRow {
  const raw = buildRaw(row, def.columns);
  const typed = def.typed ? def.typed(raw) : {};

  const out: StagingRow = { [def.key]: Number(raw[def.erpKey]) };
  for (const [column, value] of Object.entries(typed)) {
    out[column] = normalizeValue(value);
  }

  if (def.hasTimestamp && !('sql_timestamp' in typed)) {
    const ts = raw.CTIMESTAMP;
    out.sql_timestamp = typeof ts === 'string' ? ts : null;
  }

  out.raw = raw;
  out.source_hash = hashRaw(raw);
  return out;
}

/**
 * Upsert por lotes con fallback fila a fila.
 *
 * `source_changed_at` solo avanza cuando la huella cambia; `deleted_at` se
 * limpia por si la fila había sido marcada como borrada y reapareció.
 * El RETURNING distingue insertado (xmax = 0) de cambiado (la huella movió
 * `source_changed_at` a NOW() en esta misma transacción).
 */
async function upsertRows(
  def: TableDef,
  rows: RawRow[],
): Promise<UpsertOutcome> {
  const outcome: UpsertOutcome = {
    inserted: 0,
    updated: 0,
    changed: 0,
    errors: 0,
    changedIds: [],
  };
  if (rows.length === 0) return outcome;

  const staged = rows.map((r) => toStagingRow(def, r));
  const columns = Object.keys(staged[0]);
  const updatable = columns.filter((c) => c !== def.key);

  const setClause = updatable
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat([
      'synced_at = NOW()',
      'active = 1',
      'deleted_at = NULL',
      `source_changed_at = CASE
         WHEN ${def.staging}.source_hash IS DISTINCT FROM EXCLUDED.source_hash THEN NOW()
         ELSE ${def.staging}.source_changed_at END`,
    ])
    .join(', ');

  const placeholder = (col: string, n: number): string =>
    col === 'raw' ? `$${n}::jsonb` : `$${n}`;

  const runBatch = async (batch: StagingRow[]): Promise<void> => {
    const params: NonNullable<Parameters<typeof validatorDb.unsafe>[1]> = [];
    const values: string[] = [];
    let p = 1;
    for (const row of batch) {
      values.push(
        `(${columns.map((c) => placeholder(c, p++)).join(', ')}, NOW(), 1, NULL, NOW())`,
      );
      for (const c of columns) {
        // sql.json() marca el objeto para que el driver lo serialice una sola vez.
        params.push(
          c === 'raw'
            ? validatorDb.json(row[c] as NormalizedRow)
            : (row[c] as StagingValue),
        );
      }
    }

    const result = await validatorDb.unsafe<
      { id: number; inserted: boolean; changed: boolean }[]
    >(
      `INSERT INTO ${def.staging} (${columns.join(', ')}, synced_at, active, deleted_at, source_changed_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (${def.key}) DO UPDATE SET ${setClause}
       RETURNING ${def.key} AS id, (xmax = 0) AS inserted, (source_changed_at = NOW()) AS changed`,
      params,
    );

    for (const r of result) {
      if (r.inserted) outcome.inserted++;
      else outcome.updated++;
      if (r.changed) {
        outcome.changed++;
        outcome.changedIds.push(Number(r.id));
      }
    }
  };

  for (const batch of chunk(staged, UPSERT_BATCH)) {
    try {
      await runBatch(batch);
    } catch (batchError) {
      // Se aísla la fila mala para no perder el lote completo.
      for (const row of batch) {
        try {
          await runBatch([row]);
        } catch (rowError) {
          outcome.errors++;
          if (outcome.errors <= 3) {
            const message =
              rowError instanceof Error ? rowError.message : String(rowError);
            console.error(
              `  ${def.staging} ${def.key}=${String(row[def.key])}: ${message}`,
            );
          }
        }
      }
      if (outcome.errors === 0) {
        const message =
          batchError instanceof Error ? batchError.message : String(batchError);
        console.warn(
          `  ${def.staging}: lote reintentado fila a fila (${message})`,
        );
      }
    }
  }

  return outcome;
}

/** Ingesta de una tabla. `parentChanged` son los ids del padre que cambiaron en esta corrida. */
async function ingestTable(
  def: TableDef,
  options: IngestOptions,
  parentChanged: Set<number> | null,
): Promise<{ result: TableIngestResult; changedIds: Set<number> }> {
  const startedAt = Date.now();
  const erpColumns = Object.keys(def.columns);
  const changedIds = new Set<number>();

  const result: TableIngestResult = {
    table: def.erpTable,
    erpIds: 0,
    missing: 0,
    modified: 0,
    drifted: 0,
    refreshedByParent: 0,
    inserted: 0,
    updated: 0,
    changed: 0,
    deactivated: 0,
    errors: 0,
    elapsedMs: 0,
  };

  const absorb = (o: UpsertOutcome): void => {
    result.inserted += o.inserted;
    result.updated += o.updated;
    result.changed += o.changed;
    result.errors += o.errors;
    for (const id of o.changedIds) changedIds.add(id);
  };

  // 1. Universo de ids: faltantes y borrados.
  const [erpIds, staging] = await Promise.all([
    fetchIds(def.erpTable, def.erpKey),
    loadStagingState(def),
  ]);
  result.erpIds = erpIds.length;

  const partition = partitionIds(erpIds, staging);
  result.deactivated = await deactivate(def, partition.toDeactivate);

  if (options.full) {
    result.missing = erpIds.length;
    absorb(await upsertRows(def, await fetchAllRows(def.erpTable, erpColumns)));
    result.elapsedMs = Date.now() - startedAt;
    return { result, changedIds };
  }

  result.missing = partition.toFetch.length;
  if (partition.toFetch.length > 0) {
    absorb(
      await upsertRows(
        def,
        await fetchRowsWhereIn(
          def.erpTable,
          erpColumns,
          def.erpKey,
          partition.toFetch,
        ),
      ),
    );
  }

  const alreadyFetched = new Set(partition.toFetch);

  // 2. Modificados por CTIMESTAMP.
  if (def.hasTimestamp) {
    const since = await lastKnownTimestamp(def);
    if (since) {
      const rows = (
        await fetchRowsModifiedSince(def.erpTable, erpColumns, since)
      ).filter((r) => !alreadyFetched.has(Number(r[def.erpKey])));
      result.modified = rows.length;
      absorb(await upsertRows(def, rows));
      for (const r of rows) alreadyFetched.add(Number(r[def.erpKey]));
    }
  }

  // 3. Campos libres editados sin CTIMESTAMP.
  if (def.driftColumns && def.driftColumns.length > 0) {
    const [erpDrift, stagingDrift] = await Promise.all([
      fetchDriftColumns(def.erpTable, def.erpKey, def.driftColumns),
      loadStagingDrift(def),
    ]);
    const drifted = findDriftedIds(
      erpDrift,
      stagingDrift,
      def.erpKey,
      def.driftColumns,
    ).filter((id) => !alreadyFetched.has(id));
    result.drifted = drifted.length;
    if (drifted.length > 0) {
      absorb(
        await upsertRows(
          def,
          await fetchRowsWhereIn(def.erpTable, erpColumns, def.erpKey, drifted),
        ),
      );
      for (const id of drifted) alreadyFetched.add(id);
    }
  }

  // 4. Hijas de padres que cambiaron.
  if (def.parent) {
    let parentIds: number[];
    if (parentChanged) {
      parentIds = [...parentChanged];
    } else {
      const parentDef = resolveTables([def.parent.erpTable])[0];
      parentIds = await parentChangedInWindow(
        parentDef,
        options.parentWindowHours ?? 48,
      );
    }
    if (parentIds.length > 0) {
      const rows = (
        await fetchRowsWhereIn(
          def.erpTable,
          erpColumns,
          def.parent.erpColumn,
          parentIds,
        )
      ).filter((r) => !alreadyFetched.has(Number(r[def.erpKey])));
      result.refreshedByParent = rows.length;
      absorb(await upsertRows(def, rows));
    }
  }

  result.elapsedMs = Date.now() - startedAt;
  return { result, changedIds };
}

/**
 * Corre la ingesta de las tablas pedidas (todas si no se indica), en el
 * orden del registro para que los padres vayan antes que sus hijas.
 */
export async function ingestTables(
  names?: readonly string[],
  options: IngestOptions = {},
): Promise<TableIngestResult[]> {
  const defs = resolveTables(names);
  const changedByTable = new Map<string, Set<number>>();
  const results: TableIngestResult[] = [];

  for (const def of defs) {
    const parentChanged = def.parent
      ? (changedByTable.get(def.parent.erpTable) ?? null)
      : null;
    const { result, changedIds } = await ingestTable(
      def,
      options,
      parentChanged,
    );
    changedByTable.set(def.erpTable, changedIds);
    results.push(result);
  }

  return results;
}

/** Resumen compacto para sync_runs.summary y para los logs. */
export function summarizeIngest(results: readonly TableIngestResult[]): {
  rowsRead: number;
  rowsWritten: number;
  errors: number;
  tables: TableIngestResult[];
} {
  return {
    rowsRead: results.reduce(
      (n, r) => n + r.missing + r.modified + r.drifted + r.refreshedByParent,
      0,
    ),
    rowsWritten: results.reduce(
      (n, r) => n + r.inserted + r.updated + r.deactivated,
      0,
    ),
    errors: results.reduce((n, r) => n + r.errors, 0),
    tables: [...results],
  };
}
