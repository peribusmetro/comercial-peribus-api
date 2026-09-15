import sql from 'mssql';
import { requireSqlServerConfig } from '@/config/env';

/**
 * Acceso de SOLO LECTURA a AdminPAQ.
 *
 * Regla del proyecto: el ERP es la fuente de verdad contable y este servicio
 * nunca le escribe. Todas las funciones de este módulo son SELECT.
 */

let pool: sql.ConnectionPool | null = null;

export async function getSqlServerPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;

  pool = await new sql.ConnectionPool(requireSqlServerConfig()).connect();
  return pool;
}

export async function closeSqlServerPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

/** Fila cruda de admDocumentos, con los nombres originales de AdminPAQ. */
export interface RawDocument {
  CIDDOCUMENTO: number;
  CIDCONCEPTODOCUMENTO: number | null;
  CSERIEDOCUMENTO: string | null;
  CFOLIO: number | null;
  CFECHA: Date | null;
  CIDCLIENTEPROVEEDOR: number | null;
  CRAZONSOCIAL: string | null;
  CRFC: string | null;
  CREFERENCIA: string | null;
  COBSERVACIONES: string | null;
  CNATURALEZA: number | null;
  CCANCELADO: number | null;
  CNETO: number | null;
  CIMPUESTO1: number | null;
  CTOTAL: number | null;
  CIDMONEDA: number | null;
  CTIPOCAMBIO: number | null;
  CUSUARIO: string | null;
  CTEXTOEXTRA1: string | null;
  CTEXTOEXTRA2: string | null;
  CTEXTOEXTRA3: string | null;
  CTIMESTAMP: string | null;
}

export interface RawMovement {
  CIDMOVIMIENTO: number;
  CIDDOCUMENTO: number;
  CNUMEROMOVIMIENTO: number | null;
  CIDPRODUCTO: number | null;
  CIDALMACEN: number | null;
  CUNIDADES: number | null;
  CPRECIO: number | null;
  CNETO: number | null;
  CTOTAL: number | null;
  CREFERENCIA: string | null;
  COBSERVAMOV: string | null;
  CFECHA: Date | null;
  CTEXTOEXTRA1: string | null;
}

export interface RawProduct {
  CIDPRODUCTO: number;
  CCODIGOPRODUCTO: string | null;
  CNOMBREPRODUCTO: string | null;
  CTIPOPRODUCTO: number | null;
  CSTATUSPRODUCTO: number | null;
  CDESCRIPCIONPRODUCTO: string | null;
  CCLAVESAT: string | null;
  CPRECIO1: number | null;
  CIDUNIDADBASE: number | null;
}

export interface RawConcept {
  CIDCONCEPTODOCUMENTO: number;
  CCODIGOCONCEPTO: string | null;
  CNOMBRECONCEPTO: string | null;
  CNATURALEZA: number | null;
  CTIPOFOLIO: number | null;
}

/**
 * Documentos modificados o creados desde una fecha.
 *
 * CTIMESTAMP en AdminPAQ es TEXTO en formato MM/DD/YYYY, no un tipo fecha.
 * Hay que convertirlo con estilo 101 para comparar, y descartar el centinela
 * '12/30/1899' que AdminPAQ usa como "sin valor".
 */
export async function fetchDocumentsSince(since: Date | null): Promise<RawDocument[]> {
  const pool = await getSqlServerPool();

  const columns = `
    CIDDOCUMENTO, CIDCONCEPTODOCUMENTO, CSERIEDOCUMENTO, CFOLIO, CFECHA,
    CIDCLIENTEPROVEEDOR, CRAZONSOCIAL, CRFC, CREFERENCIA, COBSERVACIONES,
    CNATURALEZA, CCANCELADO, CNETO, CIMPUESTO1, CTOTAL, CIDMONEDA,
    CTIPOCAMBIO, CUSUARIO, CTEXTOEXTRA1, CTEXTOEXTRA2, CTEXTOEXTRA3, CTIMESTAMP
  `;

  if (!since) {
    const result = await pool.request().query<RawDocument>(
      `SELECT ${columns} FROM admDocumentos`,
    );
    return result.recordset;
  }

  // MM/DD/YYYY es el formato que espera CONVERT con estilo 101.
  const sinceText = `${String(since.getMonth() + 1).padStart(2, '0')}/${String(
    since.getDate(),
  ).padStart(2, '0')}/${since.getFullYear()}`;

  const result = await pool
    .request()
    .input('since', sql.VarChar(20), sinceText)
    .query<RawDocument>(`
      SELECT ${columns}
      FROM admDocumentos
      WHERE CTIMESTAMP IS NOT NULL
        AND CTIMESTAMP <> ''
        AND CTIMESTAMP <> '12/30/1899 00:00:00:000'
        AND CONVERT(DATETIME, CTIMESTAMP, 101) >= CONVERT(DATETIME, @since, 101)
    `);

  return result.recordset;
}

/** IDs de todos los documentos vivos en el ERP (para detectar borrados). */
export async function fetchAllDocumentIds(): Promise<number[]> {
  const pool = await getSqlServerPool();
  const result = await pool
    .request()
    .query<{ CIDDOCUMENTO: number }>('SELECT CIDDOCUMENTO FROM admDocumentos');
  return result.recordset.map((r) => r.CIDDOCUMENTO);
}

/** Movimientos de un lote de documentos. */
export async function fetchMovementsForDocuments(
  documentIds: number[],
): Promise<RawMovement[]> {
  if (documentIds.length === 0) return [];

  const pool = await getSqlServerPool();

  // Los ids son enteros validados por tipo, pero se sanean de todos modos:
  // nunca se interpola texto crudo en una consulta.
  const safeIds = documentIds
    .filter((id) => Number.isInteger(id))
    .map((id) => String(id))
    .join(',');

  if (!safeIds) return [];

  const result = await pool.request().query<RawMovement>(`
    SELECT
      CIDMOVIMIENTO, CIDDOCUMENTO, CNUMEROMOVIMIENTO, CIDPRODUCTO, CIDALMACEN,
      CUNIDADES, CPRECIO, CNETO, CTOTAL, CREFERENCIA, COBSERVAMOV, CFECHA,
      CTEXTOEXTRA1
    FROM admMovimientos
    WHERE CIDDOCUMENTO IN (${safeIds})
  `);

  return result.recordset;
}

export async function fetchAllProducts(): Promise<RawProduct[]> {
  const pool = await getSqlServerPool();
  const result = await pool.request().query<RawProduct>(`
    SELECT
      CIDPRODUCTO, CCODIGOPRODUCTO, CNOMBREPRODUCTO, CTIPOPRODUCTO,
      CSTATUSPRODUCTO, CDESCRIPCIONPRODUCTO, CCLAVESAT, CPRECIO1, CIDUNIDADBASE
    FROM admProductos
  `);
  return result.recordset;
}

export async function fetchAllConcepts(): Promise<RawConcept[]> {
  const pool = await getSqlServerPool();
  const result = await pool.request().query<RawConcept>(`
    SELECT
      CIDCONCEPTODOCUMENTO, CCODIGOCONCEPTO, CNOMBRECONCEPTO,
      CNATURALEZA, CTIPOFOLIO
    FROM admConceptos
  `);
  return result.recordset;
}

/**
 * Diagnóstico: qué tan poblado viene el campo de unidad.
 *
 * R1 y R3 dependen por completo de CTEXTOEXTRA2 (y CTEXTOEXTRA1 como
 * respaldo). Antes de confiar en las reglas hay que saber si el dato existe.
 */
export async function measureUnitCoverage(): Promise<{
  total: number;
  withFolio: number;
  withUnitTwo: number;
  withUnitOne: number;
  withAnyUnit: number;
}> {
  const pool = await getSqlServerPool();

  const result = await pool.request().query<{
    total: number;
    with_folio: number;
    with_unit_two: number;
    with_unit_one: number;
    with_any_unit: number;
  }>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN CTEXTOEXTRA3 IS NOT NULL AND LTRIM(RTRIM(CTEXTOEXTRA3)) <> ''
               THEN 1 ELSE 0 END) AS with_folio,
      SUM(CASE WHEN CTEXTOEXTRA2 IS NOT NULL AND LTRIM(RTRIM(CTEXTOEXTRA2)) <> ''
               THEN 1 ELSE 0 END) AS with_unit_two,
      SUM(CASE WHEN CTEXTOEXTRA1 IS NOT NULL AND LTRIM(RTRIM(CTEXTOEXTRA1)) <> ''
               THEN 1 ELSE 0 END) AS with_unit_one,
      SUM(CASE WHEN (CTEXTOEXTRA2 IS NOT NULL AND LTRIM(RTRIM(CTEXTOEXTRA2)) <> '')
                 OR (CTEXTOEXTRA1 IS NOT NULL AND LTRIM(RTRIM(CTEXTOEXTRA1)) <> '')
               THEN 1 ELSE 0 END) AS with_any_unit
    FROM admDocumentos
    WHERE CCANCELADO = 0
  `);

  const row = result.recordset[0];
  return {
    total: row.total,
    withFolio: row.with_folio,
    withUnitTwo: row.with_unit_two,
    withUnitOne: row.with_unit_one,
    withAnyUnit: row.with_any_unit,
  };
}
