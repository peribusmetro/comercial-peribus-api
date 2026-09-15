import { validatorDb } from '@/db/clients';
import { parseAdminPaqTimestamp } from '@/domain/normalize';
import {
  fetchAllConcepts,
  fetchAllProducts,
  fetchDocumentsSince,
  fetchMovementsForDocuments,
  type RawDocument,
  type RawMovement,
} from './sqlserver';

/**
 * ETL AdminPAQ → DB del validador.
 *
 * Diseñado para caber en el timeout de una función serverless: el trabajo se
 * parte en pasos (documents / movements / catalogs) que el cron encadena.
 * Cada paso es idempotente — correrlo dos veces no duplica ni corrompe.
 */

const BATCH_SIZE = 500;

export type SyncStep = 'documents' | 'movements' | 'catalogs';

export interface StepResult {
  step: SyncStep;
  rowsRead: number;
  rowsWritten: number;
  elapsedMs: number;
  details?: Record<string, unknown>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

/** Última corrida exitosa de un paso, para sincronizar incrementalmente. */
async function lastSuccessfulRunAt(step: SyncStep): Promise<Date | null> {
  const rows = await validatorDb<{ started_at: Date }[]>`
    SELECT started_at
    FROM sync_runs
    WHERE step = ${step} AND status = 'success'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].started_at : null;
}

function mapDocument(raw: RawDocument) {
  return {
    document_id: raw.CIDDOCUMENTO,
    document_concept_id: raw.CIDCONCEPTODOCUMENTO,
    document_series: raw.CSERIEDOCUMENTO?.trim() || null,
    folio: raw.CFOLIO,
    date: raw.CFECHA,
    client_supplier_id: raw.CIDCLIENTEPROVEEDOR,
    business_name: raw.CRAZONSOCIAL?.trim() || null,
    rfc: raw.CRFC?.trim() || null,
    reference: raw.CREFERENCIA?.trim() || null,
    observations: raw.COBSERVACIONES?.trim() || null,
    nature: raw.CNATURALEZA,
    cancelled: raw.CCANCELADO ?? 0,
    net_amount: raw.CNETO,
    tax_one: raw.CIMPUESTO1,
    total: raw.CTOTAL,
    currency_id: raw.CIDMONEDA,
    exchange_rate: raw.CTIPOCAMBIO,
    username: raw.CUSUARIO?.trim() || null,
    extra_text_one: raw.CTEXTOEXTRA1?.trim() || null,
    extra_text_two: raw.CTEXTOEXTRA2?.trim() || null,
    extra_text_three: raw.CTEXTOEXTRA3?.trim() || null,
    sql_timestamp: raw.CTIMESTAMP?.trim() || null,
    sql_timestamp_parsed: parseAdminPaqTimestamp(raw.CTIMESTAMP),
  };
}

function mapMovement(raw: RawMovement) {
  return {
    movement_id: raw.CIDMOVIMIENTO,
    document_id: raw.CIDDOCUMENTO,
    movement_number: raw.CNUMEROMOVIMIENTO,
    product_id: raw.CIDPRODUCTO,
    warehouse_id: raw.CIDALMACEN,
    units: raw.CUNIDADES,
    price: raw.CPRECIO,
    net_amount: raw.CNETO,
    total: raw.CTOTAL,
    reference: raw.CREFERENCIA?.trim() || null,
    observations: raw.COBSERVAMOV?.trim() || null,
    date: raw.CFECHA,
    extra_text_one: raw.CTEXTOEXTRA1?.trim() || null,
  };
}

/**
 * Paso 1 — documentos.
 *
 * Incremental por CTIMESTAMP. La primera corrida trae todo; las siguientes
 * solo lo modificado desde la última corrida exitosa (con un día de solapa
 * para no perder cambios de última hora).
 */
export async function syncDocuments(options: { full?: boolean } = {}): Promise<StepResult> {
  const startedAt = Date.now();

  let since: Date | null = null;
  if (!options.full) {
    const last = await lastSuccessfulRunAt('documents');
    if (last) {
      since = new Date(last.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  const raw = await fetchDocumentsSince(since);
  const mapped = raw.map(mapDocument);

  let written = 0;
  for (const batch of chunk(mapped, BATCH_SIZE)) {
    const result = await validatorDb`
      INSERT INTO adm_documents ${validatorDb(batch)}
      ON CONFLICT (document_id) DO UPDATE SET
        document_concept_id  = EXCLUDED.document_concept_id,
        document_series      = EXCLUDED.document_series,
        folio                = EXCLUDED.folio,
        date                 = EXCLUDED.date,
        client_supplier_id   = EXCLUDED.client_supplier_id,
        business_name        = EXCLUDED.business_name,
        rfc                  = EXCLUDED.rfc,
        reference            = EXCLUDED.reference,
        observations         = EXCLUDED.observations,
        nature               = EXCLUDED.nature,
        cancelled            = EXCLUDED.cancelled,
        net_amount           = EXCLUDED.net_amount,
        tax_one              = EXCLUDED.tax_one,
        total                = EXCLUDED.total,
        currency_id          = EXCLUDED.currency_id,
        exchange_rate        = EXCLUDED.exchange_rate,
        username             = EXCLUDED.username,
        extra_text_one       = EXCLUDED.extra_text_one,
        extra_text_two       = EXCLUDED.extra_text_two,
        extra_text_three     = EXCLUDED.extra_text_three,
        sql_timestamp        = EXCLUDED.sql_timestamp,
        sql_timestamp_parsed = EXCLUDED.sql_timestamp_parsed,
        synced_at            = NOW(),
        active               = 1
    `;
    written += result.count ?? batch.length;
  }

  return {
    step: 'documents',
    rowsRead: raw.length,
    rowsWritten: written,
    elapsedMs: Date.now() - startedAt,
    details: { mode: since ? 'incremental' : 'full', since: since?.toISOString() ?? null },
  };
}

/**
 * Paso 2 — movimientos de los documentos recién sincronizados.
 *
 * admMovimientos no tiene CTIMESTAMP, así que no se puede consultar de forma
 * incremental por fecha: se traen los movimientos de los documentos que
 * cambiaron, que es el conjunto que importa.
 */
export async function syncMovements(
  options: { documentIds?: number[]; sinceHours?: number } = {},
): Promise<StepResult> {
  const startedAt = Date.now();

  let targetIds = options.documentIds;

  if (!targetIds) {
    const hours = options.sinceHours ?? 48;
    const rows = await validatorDb<{ document_id: number }[]>`
      SELECT document_id
      FROM adm_documents
      WHERE synced_at >= NOW() - (${hours} * INTERVAL '1 hour')
    `;
    targetIds = rows.map((r) => r.document_id);
  }

  if (targetIds.length === 0) {
    return { step: 'movements', rowsRead: 0, rowsWritten: 0, elapsedMs: Date.now() - startedAt };
  }

  let read = 0;
  let written = 0;

  // Se consulta SQL Server por lotes de documentos para no armar un IN gigante.
  for (const idBatch of chunk(targetIds, 200)) {
    const raw = await fetchMovementsForDocuments(idBatch);
    read += raw.length;
    if (raw.length === 0) continue;

    const mapped = raw.map(mapMovement);

    for (const batch of chunk(mapped, BATCH_SIZE)) {
      const result = await validatorDb`
        INSERT INTO adm_movements ${validatorDb(batch)}
        ON CONFLICT (movement_id) DO UPDATE SET
          document_id     = EXCLUDED.document_id,
          movement_number = EXCLUDED.movement_number,
          product_id      = EXCLUDED.product_id,
          warehouse_id    = EXCLUDED.warehouse_id,
          units           = EXCLUDED.units,
          price           = EXCLUDED.price,
          net_amount      = EXCLUDED.net_amount,
          total           = EXCLUDED.total,
          reference       = EXCLUDED.reference,
          observations    = EXCLUDED.observations,
          date            = EXCLUDED.date,
          extra_text_one  = EXCLUDED.extra_text_one,
          synced_at       = NOW(),
          active          = 1
      `;
      written += result.count ?? batch.length;
    }
  }

  return {
    step: 'movements',
    rowsRead: read,
    rowsWritten: written,
    elapsedMs: Date.now() - startedAt,
    details: { documents_processed: targetIds.length },
  };
}

/** Paso 3 — catálogos (productos y conceptos). Son chicos, se traen completos. */
export async function syncCatalogs(): Promise<StepResult> {
  const startedAt = Date.now();

  const [products, concepts] = await Promise.all([fetchAllProducts(), fetchAllConcepts()]);

  let written = 0;

  const mappedProducts = products.map((p) => ({
    product_id: p.CIDPRODUCTO,
    product_code: p.CCODIGOPRODUCTO?.trim() || null,
    product_name: p.CNOMBREPRODUCTO?.trim() || null,
    product_type: p.CTIPOPRODUCTO,
    status: p.CSTATUSPRODUCTO,
    description: p.CDESCRIPCIONPRODUCTO?.trim() || null,
    sat_key: p.CCLAVESAT?.trim() || null,
    price_one: p.CPRECIO1,
    base_unit_id: p.CIDUNIDADBASE,
  }));

  for (const batch of chunk(mappedProducts, BATCH_SIZE)) {
    const result = await validatorDb`
      INSERT INTO adm_products ${validatorDb(batch)}
      ON CONFLICT (product_id) DO UPDATE SET
        product_code = EXCLUDED.product_code,
        product_name = EXCLUDED.product_name,
        product_type = EXCLUDED.product_type,
        status       = EXCLUDED.status,
        description  = EXCLUDED.description,
        sat_key      = EXCLUDED.sat_key,
        price_one    = EXCLUDED.price_one,
        base_unit_id = EXCLUDED.base_unit_id,
        synced_at    = NOW(),
        active       = 1
    `;
    written += result.count ?? batch.length;
  }

  const mappedConcepts = concepts.map((c) => ({
    concept_id: c.CIDCONCEPTODOCUMENTO,
    concept_code: c.CCODIGOCONCEPTO?.trim() || null,
    concept_name: c.CNOMBRECONCEPTO?.trim() || null,
    nature: c.CNATURALEZA,
    folio_type: c.CTIPOFOLIO,
  }));

  if (mappedConcepts.length > 0) {
    const result = await validatorDb`
      INSERT INTO adm_concepts ${validatorDb(mappedConcepts)}
      ON CONFLICT (concept_id) DO UPDATE SET
        concept_code = EXCLUDED.concept_code,
        concept_name = EXCLUDED.concept_name,
        nature       = EXCLUDED.nature,
        folio_type   = EXCLUDED.folio_type,
        synced_at    = NOW(),
        active       = 1
    `;
    written += result.count ?? mappedConcepts.length;
  }

  return {
    step: 'catalogs',
    rowsRead: products.length + concepts.length,
    rowsWritten: written,
    elapsedMs: Date.now() - startedAt,
    details: { products: products.length, concepts: concepts.length },
  };
}
