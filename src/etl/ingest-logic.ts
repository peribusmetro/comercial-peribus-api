import { createHash } from 'node:crypto';
import type { RawRow } from './tables';

/**
 * Lógica pura de la ingesta: sin base de datos, sin red.
 *
 * Se separa del motor (`ingest.ts`) para poder probar con casos concretos
 * las decisiones que importan: qué cuenta como cambio, qué está borrado y
 * qué campos libres se desfasaron.
 */

/**
 * Normaliza un valor del ERP para que el `raw` y el hash sean deterministas.
 *
 * mssql devuelve Date para datetime; JSON.stringify los serializa bien pero
 * se hace explícito. `undefined` (columna ausente) se vuelve null para que
 * dos lecturas de la misma fila produzcan la misma huella.
 */
export type NormalizedValue = string | number | boolean | null;
/** Fila cruda ya normalizada: lo que se guarda en `raw` y se hashea. */
export type NormalizedRow = Record<string, NormalizedValue>;

export function normalizeValue(value: unknown): NormalizedValue {
  if (value == null) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return String(value);
}

/**
 * Arma la fila cruda con SOLO las columnas del mapa, en el orden del mapa.
 *
 * El orden fijo es lo que hace estable el hash: JSON.stringify respeta el
 * orden de inserción de las claves.
 */
export function buildRaw(
  row: RawRow,
  columns: Readonly<Record<string, string>>,
): NormalizedRow {
  const raw: NormalizedRow = {};
  for (const erpColumn of Object.keys(columns)) {
    raw[erpColumn] = normalizeValue(row[erpColumn]);
  }
  return raw;
}

/** Huella de la fila cruda (sha1 hex, 40 caracteres). */
export function hashRaw(raw: NormalizedRow): string {
  return createHash('sha1').update(JSON.stringify(raw)).digest('hex');
}

export interface StagingState {
  /** Id presente en staging. */
  id: number;
  /** Ya está marcado como borrado del ERP. */
  deleted: boolean;
  /** Tiene raw/hash (filas anteriores a la migración 004 no lo tienen). */
  hydrated: boolean;
}

export interface IdPartition {
  /** En el ERP pero no en staging, o en staging sin raw: hay que traerlos. */
  toFetch: number[];
  /** En staging (vivos) pero ya no en el ERP: marcar borrados. */
  toDeactivate: number[];
  /** Estaban borrados y reaparecieron en el ERP: se traen y reviven. */
  resurrected: number[];
}

/** Compara el universo de ids del ERP contra el de staging. */
export function partitionIds(
  erpIds: Iterable<number>,
  staging: Iterable<StagingState>,
): IdPartition {
  const erp = new Set<number>();
  for (const id of erpIds) erp.add(id);

  const known = new Map<number, StagingState>();
  for (const s of staging) known.set(s.id, s);

  const toFetch: number[] = [];
  const resurrected: number[] = [];
  for (const id of erp) {
    const s = known.get(id);
    if (!s) {
      toFetch.push(id);
    } else if (s.deleted) {
      resurrected.push(id);
      toFetch.push(id);
    } else if (!s.hydrated) {
      toFetch.push(id);
    }
  }

  const toDeactivate: number[] = [];
  for (const s of known.values()) {
    if (!s.deleted && !erp.has(s.id)) toDeactivate.push(s.id);
  }

  return { toFetch, toDeactivate, resurrected };
}

const norm = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : v == null ? '' : String(v);

/**
 * Ids cuyos campos libres difieren entre el ERP y staging.
 *
 * `erpRows` trae solo las filas del ERP con algún campo libre no vacío (es
 * la consulta barata). Una fila de staging con texto que NO aparece en ese
 * conjunto significa que en el ERP los borraron: también se refresca.
 */
export function findDriftedIds(
  erpRows: readonly RawRow[],
  stagingRows: readonly RawRow[],
  idColumn: string,
  driftColumns: readonly string[],
): number[] {
  const erpById = new Map<number, RawRow>();
  for (const row of erpRows) erpById.set(Number(row[idColumn]), row);

  const drifted = new Set<number>();

  for (const current of stagingRows) {
    const id = Number(current[idColumn]);
    const incoming = erpById.get(id);

    if (!incoming) {
      // El ERP ya no tiene texto en ningún campo; si staging sí, cambió.
      if (driftColumns.some((c) => norm(current[c]) !== '')) drifted.add(id);
      continue;
    }

    if (driftColumns.some((c) => norm(current[c]) !== norm(incoming[c])))
      drifted.add(id);
    erpById.delete(id);
  }

  // Lo que quedó en erpById no está en staging: lo cubre la detección de
  // faltantes por id, no esta función.
  return [...drifted];
}

/** Parte un arreglo en trozos de tamaño fijo. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
