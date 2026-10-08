import sql from 'mssql';
import { requireSqlServerConfig } from '../config/env';
import { chunk } from './ingest-logic';
import type { RawRow } from './tables';

/**
 * Acceso de SOLO LECTURA a AdminPAQ.
 *
 * Regla del proyecto: el ERP es la fuente de verdad contable y este servicio
 * nunca le escribe. Todas las funciones de este módulo son SELECT.
 *
 * Las consultas son genéricas (tabla + columnas) porque la ingesta recorre
 * las 9 tablas del registro (`tables.ts`) con la misma estrategia. Los
 * nombres de tabla y columna vienen del registro, nunca de una petición.
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

/** Centinela de AdminPAQ para "sin fecha" en CTIMESTAMP (texto). */
const TIMESTAMP_SENTINEL = '12/30/1899 00:00:00:000';

/** Solo letras, números y guion bajo: lo que puede ser un identificador de AdminPAQ. */
function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Identificador SQL inválido: "${name}"`);
  }
  return name;
}

function columnList(columns: readonly string[]): string {
  return columns.map(assertIdentifier).join(', ');
}

/** Todos los ids de una tabla del ERP (para faltantes y borrados). */
export async function fetchIds(
  erpTable: string,
  erpKey: string,
): Promise<number[]> {
  const p = await getSqlServerPool();
  const result = await p
    .request()
    .query<Record<string, number>>(
      `SELECT ${assertIdentifier(erpKey)} FROM ${assertIdentifier(erpTable)}`,
    );
  return result.recordset.map((r) => Number(r[erpKey]));
}

/** Tabla completa (carga inicial o tablas chicas). */
export async function fetchAllRows(
  erpTable: string,
  columns: readonly string[],
): Promise<RawRow[]> {
  const p = await getSqlServerPool();
  const result = await p
    .request()
    .query<RawRow>(
      `SELECT ${columnList(columns)} FROM ${assertIdentifier(erpTable)}`,
    );
  return result.recordset;
}

/**
 * Filas cuya columna `filterColumn` está en `values`, por lotes.
 *
 * Los valores son enteros validados: nunca se interpola texto crudo. SQL
 * Server admite listas IN largas, pero se parte en lotes de 1,000 para que
 * cada consulta sea predecible.
 */
export async function fetchRowsWhereIn(
  erpTable: string,
  columns: readonly string[],
  filterColumn: string,
  values: readonly number[],
): Promise<RawRow[]> {
  const ids = values.filter((v) => Number.isInteger(v));
  if (ids.length === 0) return [];

  const p = await getSqlServerPool();
  const table = assertIdentifier(erpTable);
  const column = assertIdentifier(filterColumn);
  const cols = columnList(columns);

  const out: RawRow[] = [];
  for (const batch of chunk(ids, 1000)) {
    const result = await p
      .request()
      .query<RawRow>(
        `SELECT ${cols} FROM ${table} WHERE ${column} IN (${batch.join(',')})`,
      );
    out.push(...result.recordset);
  }
  return out;
}

/**
 * Filas modificadas desde un CTIMESTAMP conocido (inclusive).
 *
 * CTIMESTAMP en AdminPAQ es TEXTO en formato MM/DD/YYYY HH:MM:SS:mmm, no un
 * tipo fecha. Hay que convertirlo con estilo 101 para comparar y descartar
 * el centinela '12/30/1899'. Se usa >= y no >: re-leer las filas con el
 * mismo timestamp es barato y evita perder cambios del mismo instante.
 */
export async function fetchRowsModifiedSince(
  erpTable: string,
  columns: readonly string[],
  sinceTimestamp: string,
): Promise<RawRow[]> {
  const p = await getSqlServerPool();
  const result = await p
    .request()
    .input('since', sql.VarChar(40), sinceTimestamp)
    .input('sentinel', sql.VarChar(40), TIMESTAMP_SENTINEL).query<RawRow>(`
      SELECT ${columnList(columns)}
      FROM ${assertIdentifier(erpTable)}
      WHERE CTIMESTAMP IS NOT NULL
        AND CTIMESTAMP <> ''
        AND CTIMESTAMP <> @sentinel
        AND CONVERT(DATETIME, CTIMESTAMP, 101) >= CONVERT(DATETIME, @since, 101)
    `);
  return result.recordset;
}

/**
 * Id + columnas de texto libre de las filas que tienen alguna no vacía.
 *
 * Es la consulta barata que permite detectar ediciones de CTEXTOEXTRA* sin
 * CTIMESTAMP: se compara en memoria contra staging.
 */
export async function fetchDriftColumns(
  erpTable: string,
  erpKey: string,
  driftColumns: readonly string[],
): Promise<RawRow[]> {
  const p = await getSqlServerPool();
  const cols = driftColumns.map(assertIdentifier);
  const where = cols
    .map((c) => `(${c} IS NOT NULL AND ${c} <> '')`)
    .join(' OR ');
  const result = await p
    .request()
    .query<RawRow>(
      `SELECT ${assertIdentifier(erpKey)}, ${cols.join(', ')} FROM ${assertIdentifier(erpTable)} WHERE ${where}`,
    );
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
  const p = await getSqlServerPool();

  const result = await p.request().query<{
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
