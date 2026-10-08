import { appDb, validatorDb } from '../db/clients';
import { chunk, type NormalizedRow } from '../etl/ingest-logic';
import { resolveTables, type TableDef } from '../etl/tables';
import {
  appRowToErp,
  buildDiff,
  canBeHeld,
  classifyChange,
  rawToAppValues,
  type ChangeType,
  type DiffEntry,
} from './publish-logic';

/**
 * Publicador: staging del validador → base de la app.
 *
 * ESTE MÓDULO ESCRIBE EN LA BASE DE LA APP (junto con link-applier.ts).
 * Escribe las 9 tablas `comercial_adm_*` y, al sincronizar una cancelación o
 * un borrado, desactiva los vínculos del documento. Nada más.
 *
 * Regla por fila (ver docs/planning/2026-10-08 en la app):
 *   · nueva                                     → INSERT en la app
 *   · cambió en origen, sin vínculos en la app  → UPDATE en la app
 *   · borrada en el ERP, sin vínculos           → active = 0 en la app
 *   · cambió / canceló / borró en origen y el documento TIENE vínculos
 *     (document_links, movement_folio_links o movement_unit_links activos)
 *     → NO se toca la app. Se retiene y se registra en source_changes para
 *       que alguien decida en la app: sincronizar con el origen o quedarse
 *       con su versión.
 *   · cambió en origen pero solo en columnas sin importancia (CTIMESTAMP,
 *     usuario…) → se publica en silencio aunque tenga vínculos.
 *
 * `published_rows` es la memoria de qué versión tiene la app; sin ella no se
 * puede distinguir "nuevo" de "cambiado".
 */

const CANDIDATE_BATCH = 1000;
const WRITE_BATCH = 500;

type Params = NonNullable<Parameters<typeof validatorDb.unsafe>[1]>;

export interface TablePublishResult {
  table: string;
  candidates: number;
  inserted: number;
  updated: number;
  deactivated: number;
  held: number;
  /** Cambió en origen pero sin diferencias significativas: se publicó en silencio. */
  silent: number;
  errors: number;
  elapsedMs: number;
}

export interface PublishSummary {
  dryRun: boolean;
  tables: TablePublishResult[];
  heldDocuments: number;
  changesOpened: number;
  changesUpdated: number;
  changesObsoleted: number;
  errors: number;
}

export interface PublishOptions {
  tables?: readonly string[];
  /** Calcula y reporta sin escribir en la app ni en published_rows/source_changes. */
  dryRun?: boolean;
  runId?: number | null;
}

interface Candidate {
  id: number;
  raw: NormalizedRow | null;
  sourceHash: string;
  deleted: boolean;
  documentId: number | null;
}

interface HeldDocument {
  entries: DiffEntry[];
  documentDeleted: boolean;
  documentHash: string | null;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/** Filas de staging cuya versión no coincide con la publicada, por lotes. */
async function loadCandidates(
  def: TableDef,
  afterId: number,
): Promise<Candidate[]> {
  const docRef =
    def.erpTable === 'admDocumentos'
      ? `s.${def.key}`
      : def.erpTable === 'admMovimientos'
        ? `(s.raw->>'CIDDOCUMENTO')::int`
        : 'NULL::int';

  const rows = await validatorDb.unsafe<
    {
      id: number;
      raw: NormalizedRow | null;
      source_hash: string;
      deleted: boolean;
      document_id: number | null;
    }[]
  >(
    `SELECT s.${def.key} AS id, s.raw, s.source_hash,
            (s.deleted_at IS NOT NULL) AS deleted,
            ${docRef} AS document_id
     FROM ${def.staging} s
     LEFT JOIN published_rows p ON p.table_name = $1 AND p.row_id = s.${def.key}
     WHERE s.${def.key} > $2
       AND s.source_hash IS NOT NULL
       AND (
         p.row_id IS NULL
         OR p.published_hash IS DISTINCT FROM s.source_hash
         OR p.published_deleted <> (s.deleted_at IS NOT NULL)
       )
     ORDER BY s.${def.key}
     LIMIT $3`,
    [def.erpTable, afterId, CANDIDATE_BATCH],
  );

  return rows.map((r) => ({
    id: Number(r.id),
    raw: r.deleted ? null : r.raw,
    sourceHash: r.source_hash,
    deleted: r.deleted,
    documentId: r.document_id == null ? null : Number(r.document_id),
  }));
}

/**
 * Documentos con vínculos vigentes en la app. Es la definición de
 * "modificado en la app": la app nunca escribe comercial_adm_*, lo único que
 * decide sobre un documento es a qué folio o unidad lo liga.
 */
async function fetchLinkedDocumentIds(
  documentIds: readonly number[],
): Promise<Set<number>> {
  if (documentIds.length === 0) return new Set();
  const rows = await appDb<{ document_id: number }[]>`
    SELECT DISTINCT document_id FROM (
      SELECT document_id FROM comercial_document_links
       WHERE active = 1 AND document_id = ANY(${documentIds})
      UNION ALL
      SELECT document_id FROM comercial_movement_folio_links
       WHERE active = 1 AND document_id = ANY(${documentIds})
      UNION ALL
      SELECT mv.document_id
        FROM comercial_movement_unit_links l
        JOIN comercial_adm_movements mv ON mv.movement_id = l.movement_id
       WHERE l.active = 1 AND mv.document_id = ANY(${documentIds})
    ) x
  `;
  return new Set(rows.map((r) => Number(r.document_id)));
}

/** Lo que la app tiene hoy de esas filas, en vocabulario ERP. */
async function fetchAppRowsAsErp(
  def: TableDef,
  ids: readonly number[],
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  if (ids.length === 0) return out;

  const appColumns = Object.values(def.columns);
  const rows = await appDb.unsafe<Record<string, unknown>[]>(
    `SELECT ${appColumns.join(', ')} FROM ${def.appTable} WHERE ${def.key} = ANY($1::bigint[])`,
    [ids as number[]],
  );
  for (const row of rows) {
    out.set(Number(row[def.key]), appRowToErp(row, def.columns));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escrituras en la app
// ---------------------------------------------------------------------------

async function upsertApp(
  def: TableDef,
  rows: readonly Candidate[],
): Promise<{ inserted: number; updated: number; errors: number }> {
  const result = { inserted: 0, updated: 0, errors: 0 };
  if (rows.length === 0) return result;

  const appColumns = Object.values(def.columns);
  const setClause = appColumns
    .filter((c) => c !== def.key)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat(['synced_at = NOW()', 'active = 1'])
    .join(', ');

  const runBatch = async (batch: readonly Candidate[]): Promise<void> => {
    const params: Params = [];
    const values: string[] = [];
    let p = 1;
    for (const c of batch) {
      const v = rawToAppValues(c.raw ?? {}, def.columns);
      values.push(`(${appColumns.map(() => `$${p++}`).join(', ')}, NOW(), 1)`);
      for (const col of appColumns) params.push(v[col]);
    }
    const out = await appDb.unsafe<{ inserted: boolean }[]>(
      `INSERT INTO ${def.appTable} (${appColumns.join(', ')}, synced_at, active)
       VALUES ${values.join(', ')}
       ON CONFLICT (${def.key}) DO UPDATE SET ${setClause}
       RETURNING (xmax = 0) AS inserted`,
      params,
    );
    for (const r of out) {
      if (r.inserted) result.inserted++;
      else result.updated++;
    }
  };

  for (const batch of chunk(rows, WRITE_BATCH)) {
    try {
      await runBatch(batch);
    } catch {
      for (const row of batch) {
        try {
          await runBatch([row]);
        } catch (err) {
          result.errors++;
          if (result.errors <= 3) {
            console.error(
              `  ${def.appTable} ${def.key}=${row.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }
  return result;
}

async function deactivateApp(
  def: TableDef,
  ids: readonly number[],
): Promise<number> {
  let total = 0;
  for (const batch of chunk(ids, WRITE_BATCH)) {
    const r = await appDb.unsafe(
      `UPDATE ${def.appTable} SET active = 0, synced_at = NOW()
       WHERE ${def.key} = ANY($1::bigint[]) AND active = 1`,
      [batch],
    );
    total += r.count;
  }
  return total;
}

/** Desactiva los vínculos de un documento (cancelado o borrado en el ERP). */
async function deactivateLinks(
  documentId: number,
  movementIds: readonly number[],
): Promise<{
  document_links: number;
  movement_folio_links: number;
  movement_unit_links: number;
}> {
  const [a, b, c] = await Promise.all([
    appDb`UPDATE comercial_document_links SET active = 0
          WHERE document_id = ${documentId} AND active = 1`,
    appDb`UPDATE comercial_movement_folio_links SET active = 0
          WHERE document_id = ${documentId} AND active = 1`,
    movementIds.length > 0
      ? appDb`UPDATE comercial_movement_unit_links SET active = 0
              WHERE movement_id = ANY(${movementIds as number[]}) AND active = 1`
      : Promise.resolve({ count: 0 }),
  ]);
  return {
    document_links: a.count,
    movement_folio_links: b.count,
    movement_unit_links: c.count,
  };
}

// ---------------------------------------------------------------------------
// Memoria de publicación
// ---------------------------------------------------------------------------

async function markPublished(
  def: TableDef,
  rows: readonly { id: number; hash: string; deleted: boolean }[],
): Promise<void> {
  for (const batch of chunk(rows, WRITE_BATCH)) {
    const params: Params = [];
    const values: string[] = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(def.erpTable, r.id, r.hash, r.deleted);
    }
    await validatorDb.unsafe(
      `INSERT INTO published_rows (table_name, row_id, published_hash, published_deleted)
       VALUES ${values.join(', ')}
       ON CONFLICT (table_name, row_id) DO UPDATE SET
         published_hash    = EXCLUDED.published_hash,
         published_deleted = EXCLUDED.published_deleted,
         published_at      = NOW(),
         held_hash         = NULL,
         held_since        = NULL`,
      params,
    );
  }
}

async function markHeld(
  def: TableDef,
  rows: readonly { id: number; hash: string }[],
): Promise<void> {
  for (const batch of chunk(rows, WRITE_BATCH)) {
    const params: Params = [];
    const values: string[] = [];
    let p = 1;
    for (const r of batch) {
      // published_hash queda NULL en el bootstrap: la app tenía la fila antes
      // de que existiera esta memoria y no se conoce su versión exacta.
      values.push(`($${p++}, $${p++}, NULL, FALSE, $${p++}, NOW())`);
      params.push(def.erpTable, r.id, r.hash);
    }
    await validatorDb.unsafe(
      `INSERT INTO published_rows (table_name, row_id, published_hash, published_deleted, held_hash, held_since)
       VALUES ${values.join(', ')}
       ON CONFLICT (table_name, row_id) DO UPDATE SET
         held_hash  = EXCLUDED.held_hash,
         held_since = COALESCE(published_rows.held_since, NOW())`,
      params,
    );
  }
}

/** Filas que estaban retenidas y cuyo origen volvió a coincidir con lo publicado. */
async function releaseStaleHolds(def: TableDef): Promise<number> {
  const r = await validatorDb.unsafe(
    `UPDATE published_rows p
     SET held_hash = NULL, held_since = NULL
     FROM ${def.staging} s
     WHERE p.table_name = $1
       AND p.row_id = s.${def.key}
       AND p.held_hash IS NOT NULL
       AND p.published_hash = s.source_hash
       AND p.published_deleted = (s.deleted_at IS NOT NULL)`,
    [def.erpTable],
  );
  return r.count;
}

// ---------------------------------------------------------------------------
// Cambios de origen
// ---------------------------------------------------------------------------

async function persistSourceChanges(
  held: Map<number, HeldDocument>,
  runId: number | null,
): Promise<{ opened: number; updated: number }> {
  const out = { opened: 0, updated: 0 };

  for (const [documentId, h] of held) {
    let documentHash = h.documentHash;
    if (!documentHash) {
      const [row] = await validatorDb<{ source_hash: string | null }[]>`
        SELECT source_hash FROM adm_documents WHERE document_id = ${documentId}`;
      documentHash = row?.source_hash ?? null;
    }
    const changeType: ChangeType = classifyChange(h.entries, h.documentDeleted);

    const [row] = await validatorDb<{ inserted: boolean }[]>`
      INSERT INTO source_changes (document_id, change_type, diff, source_hash, run_id)
      VALUES (${documentId}, ${changeType}, ${validatorDb.json(h.entries as unknown as never)}, ${documentHash}, ${runId})
      ON CONFLICT (document_id) WHERE status = 'pending' DO UPDATE SET
        change_type = EXCLUDED.change_type,
        diff        = EXCLUDED.diff,
        source_hash = EXCLUDED.source_hash,
        run_id      = EXCLUDED.run_id,
        updated_at  = NOW()
      RETURNING (xmax = 0) AS inserted`;

    if (row?.inserted) out.opened++;
    else out.updated++;
  }
  return out;
}

/** Pendientes cuyo documento ya no tiene nada retenido: el ERP volvió atrás. */
async function obsoleteResolvedChanges(): Promise<number> {
  // Primero el conjunto (chico) de documentos con algo retenido, y luego el
  // UPDATE contra él. La versión correlacionada (NOT EXISTS con un IN sobre
  // 166k movimientos por cada cambio) tardaba 85 s y pasaba el statement
  // timeout del pooler.
  const r = await validatorDb`
    WITH held_docs AS (
      SELECT row_id AS document_id
      FROM published_rows
      WHERE table_name = 'admDocumentos' AND held_hash IS NOT NULL
      UNION
      SELECT m.document_id
      FROM published_rows p
      JOIN adm_movements m ON m.movement_id = p.row_id
      WHERE p.table_name = 'admMovimientos' AND p.held_hash IS NOT NULL
    )
    UPDATE source_changes c
    SET status = 'obsolete', resolved_at = NOW(),
        resolved_note = 'El origen volvió a coincidir con lo publicado antes de que alguien decidiera'
    WHERE c.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM held_docs h WHERE h.document_id = c.document_id)`;
  return r.count;
}

// ---------------------------------------------------------------------------
// Corrida de publicación
// ---------------------------------------------------------------------------

async function publishTable(
  def: TableDef,
  options: PublishOptions,
  held: Map<number, HeldDocument>,
): Promise<TablePublishResult> {
  const startedAt = Date.now();
  const result: TablePublishResult = {
    table: def.erpTable,
    candidates: 0,
    inserted: 0,
    updated: 0,
    deactivated: 0,
    held: 0,
    silent: 0,
    errors: 0,
    elapsedMs: 0,
  };

  const holdable = canBeHeld(def.erpTable);
  const isMovements = def.erpTable === 'admMovimientos';

  if (!options.dryRun && holdable) await releaseStaleHolds(def);

  let afterId = 0;
  for (;;) {
    const candidates = await loadCandidates(def, afterId);
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].id;
    result.candidates += candidates.length;

    const toUpsert: Candidate[] = [];
    const toDeactivate: Candidate[] = [];
    const toHold: Candidate[] = [];

    let linked = new Set<number>();
    let appRows = new Map<number, Record<string, unknown>>();
    if (holdable) {
      const docIds = [
        ...new Set(
          candidates
            .map((c) => c.documentId)
            .filter((d): d is number => d != null),
        ),
      ];
      linked = await fetchLinkedDocumentIds(docIds);
      const linkedRows = candidates.filter(
        (c) => c.documentId != null && linked.has(c.documentId),
      );
      appRows = await fetchAppRowsAsErp(
        def,
        linkedRows.map((c) => c.id),
      );
    }

    for (const c of candidates) {
      const isLinked =
        holdable && c.documentId != null && linked.has(c.documentId);

      if (!isLinked) {
        (c.deleted ? toDeactivate : toUpsert).push(c);
        continue;
      }

      const before = appRows.get(c.id) ?? null;
      if (before === null && c.deleted) {
        // Nunca llegó a la app y ya no existe: solo se anota como publicada.
        toDeactivate.push(c);
        continue;
      }

      const diff = buildDiff(
        def.erpTable,
        before,
        c.raw,
        isMovements ? c.id : undefined,
      );
      if (diff.length === 0) {
        result.silent++;
        (c.deleted ? toDeactivate : toUpsert).push(c);
        continue;
      }

      toHold.push(c);
      const documentId = c.documentId!;
      const entry = held.get(documentId) ?? {
        entries: [],
        documentDeleted: false,
        documentHash: null,
      };
      entry.entries.push(...diff);
      if (!isMovements) {
        entry.documentDeleted = c.deleted;
        entry.documentHash = c.sourceHash;
      }
      held.set(documentId, entry);
    }

    result.held += toHold.length;

    if (options.dryRun) {
      result.inserted += toUpsert.length; // estimación: no se distingue insert de update sin escribir
      result.deactivated += toDeactivate.length;
      continue;
    }

    const w = await upsertApp(def, toUpsert);
    result.inserted += w.inserted;
    result.updated += w.updated;
    result.errors += w.errors;
    result.deactivated += await deactivateApp(
      def,
      toDeactivate.map((c) => c.id),
    );

    // Solo se marca como publicado lo que sí se escribió. Si upsertApp tuvo
    // errores de fila no sabemos cuáles: en ese caso no se marca nada del
    // lote y volverán a ser candidatas en la siguiente corrida.
    if (w.errors === 0) {
      await markPublished(def, [
        ...toUpsert.map((c) => ({
          id: c.id,
          hash: c.sourceHash,
          deleted: false,
        })),
        ...toDeactivate.map((c) => ({
          id: c.id,
          hash: c.sourceHash,
          deleted: true,
        })),
      ]);
    }
    await markHeld(
      def,
      toHold.map((c) => ({ id: c.id, hash: c.sourceHash })),
    );
  }

  result.elapsedMs = Date.now() - startedAt;
  return result;
}

export async function runPublish(
  options: PublishOptions = {},
): Promise<PublishSummary> {
  const defs = resolveTables(options.tables);
  const held = new Map<number, HeldDocument>();
  const tables: TablePublishResult[] = [];

  for (const def of defs) {
    tables.push(await publishTable(def, options, held));
  }

  let opened = 0;
  let updated = 0;
  let obsoleted = 0;
  if (!options.dryRun) {
    ({ opened, updated } = await persistSourceChanges(
      held,
      options.runId ?? null,
    ));
    const coversDocuments = defs.some((d) => d.erpTable === 'admDocumentos');
    const coversMovements = defs.some((d) => d.erpTable === 'admMovimientos');
    if (coversDocuments && coversMovements)
      obsoleted = await obsoleteResolvedChanges();
  }

  return {
    dryRun: options.dryRun ?? false,
    tables,
    heldDocuments: held.size,
    changesOpened: opened,
    changesUpdated: updated,
    changesObsoleted: obsoleted,
    errors: tables.reduce((n, t) => n + t.errors, 0),
  };
}

// ---------------------------------------------------------------------------
// Resolución desde la app
// ---------------------------------------------------------------------------

export interface SourceChangeRow {
  id: number;
  document_id: number;
  change_type: ChangeType;
  diff: DiffEntry[];
  source_hash: string | null;
  status: 'pending' | 'synced' | 'kept' | 'obsolete';
  detected_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_note: string | null;
  resolution: Record<string, unknown> | null;
}

export class ChangeNotPendingError extends Error {
  constructor(public readonly status: string) {
    super(`El cambio ya fue resuelto (${status})`);
  }
}

export class ChangeNotFoundError extends Error {
  constructor() {
    super('Cambio no encontrado');
  }
}

async function loadChange(id: number): Promise<SourceChangeRow> {
  const [row] = await validatorDb<SourceChangeRow[]>`
    SELECT * FROM source_changes WHERE id = ${id}`;
  if (!row) throw new ChangeNotFoundError();
  return row;
}

async function heldRowsForDocument(documentId: number): Promise<{
  documentHeld: boolean;
  movementIds: number[];
  allMovementIds: number[];
}> {
  const movements = await validatorDb<{ movement_id: number }[]>`
    SELECT movement_id FROM adm_movements WHERE document_id = ${documentId}`;
  const allMovementIds = movements.map((m) => Number(m.movement_id));

  const rows = await validatorDb<{ table_name: string; row_id: number }[]>`
    SELECT table_name, row_id FROM published_rows
    WHERE held_hash IS NOT NULL
      AND (
        (table_name = 'admDocumentos' AND row_id = ${documentId})
        OR (table_name = 'admMovimientos' AND row_id = ANY(${allMovementIds}))
      )`;

  return {
    documentHeld: rows.some((r) => r.table_name === 'admDocumentos'),
    movementIds: rows
      .filter((r) => r.table_name === 'admMovimientos')
      .map((r) => Number(r.row_id)),
    allMovementIds,
  };
}

/** Publica en la app las filas retenidas de un documento (versión actual del ERP). */
async function publishHeldRows(
  def: TableDef,
  ids: readonly number[],
): Promise<{ written: number; deactivated: number }> {
  if (ids.length === 0) return { written: 0, deactivated: 0 };

  const rows = await validatorDb.unsafe<
    {
      id: number;
      raw: NormalizedRow | null;
      source_hash: string;
      deleted: boolean;
    }[]
  >(
    `SELECT ${def.key} AS id, raw, source_hash, (deleted_at IS NOT NULL) AS deleted
     FROM ${def.staging} WHERE ${def.key} = ANY($1::bigint[])`,
    [ids as number[]],
  );
  const candidates: Candidate[] = rows.map((r) => ({
    id: Number(r.id),
    raw: r.deleted ? null : r.raw,
    sourceHash: r.source_hash,
    deleted: r.deleted,
    documentId: null,
  }));

  const live = candidates.filter((c) => !c.deleted);
  const gone = candidates.filter((c) => c.deleted);
  const w = await upsertApp(def, live);
  if (w.errors > 0)
    throw new Error(
      `No se pudo escribir ${def.appTable}: ${w.errors} fila(s) con error`,
    );
  const deactivated = await deactivateApp(
    def,
    gone.map((c) => c.id),
  );
  await markPublished(def, [
    ...live.map((c) => ({ id: c.id, hash: c.sourceHash, deleted: false })),
    ...gone.map((c) => ({ id: c.id, hash: c.sourceHash, deleted: true })),
  ]);
  return { written: w.inserted + w.updated, deactivated };
}

/**
 * Resuelve un cambio de origen desde la app.
 *
 *   sync → la app recibe la versión del ERP; si fue cancelación o borrado,
 *          además se desactivan los vínculos del documento.
 *   keep → la app conserva su versión; no se vuelve a avisar por esa misma
 *          versión del ERP (sí por una posterior).
 */
export async function resolveSourceChange(
  id: number,
  action: 'sync' | 'keep',
  resolvedBy: string,
  note?: string,
): Promise<{ change: SourceChangeRow; resolution: Record<string, unknown> }> {
  const change = await loadChange(id);
  if (change.status !== 'pending')
    throw new ChangeNotPendingError(change.status);

  const [docDef, movDef] = resolveTables(['admDocumentos', 'admMovimientos']);
  const held = await heldRowsForDocument(change.document_id);
  const resolution: Record<string, unknown> = { action };

  if (action === 'sync') {
    const doc = await publishHeldRows(
      docDef,
      held.documentHeld ? [change.document_id] : [],
    );
    const movs = await publishHeldRows(movDef, held.movementIds);
    resolution.document = doc;
    resolution.movements = movs;

    if (
      change.change_type === 'cancelled' ||
      change.change_type === 'deleted'
    ) {
      resolution.deactivated_links = await deactivateLinks(
        change.document_id,
        held.allMovementIds,
      );
    }
  } else {
    const r = await validatorDb`
      UPDATE published_rows
      SET published_hash = held_hash, held_hash = NULL, held_since = NULL
      WHERE held_hash IS NOT NULL
        AND (
          (table_name = 'admDocumentos' AND row_id = ${change.document_id})
          OR (table_name = 'admMovimientos' AND row_id = ANY(${held.allMovementIds}))
        )`;
    resolution.rows_kept = r.count;
  }

  const [updated] = await validatorDb<SourceChangeRow[]>`
    UPDATE source_changes
    SET status = ${action === 'sync' ? 'synced' : 'kept'},
        resolved_at = NOW(),
        resolved_by = ${resolvedBy},
        resolved_note = ${note ?? null},
        resolution = ${validatorDb.json(resolution as never)}
    WHERE id = ${id}
    RETURNING *`;

  return { change: updated, resolution };
}
