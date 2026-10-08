import type { NormalizedRow } from '../etl/ingest-logic';

/**
 * Lógica pura de la publicación: sin base de datos, sin red.
 *
 * Decide qué cambió "de verdad" entre lo que la app tiene y lo que el ERP
 * trae ahora, y cómo clasificarlo. Es lo que la app muestra en el diálogo de
 * "Modificado en origen", así que las etiquetas van en español.
 */

export interface DiffEntry {
  column: string;
  label: string;
  before: string | number | null;
  after: string | number | null;
  /** Presente cuando el cambio es en una línea (movimiento) del documento. */
  movement_id?: number;
}

export type ChangeType = 'modified' | 'cancelled' | 'deleted';

type Kind = 'date' | 'number' | 'text' | 'flag';

interface SignificantColumn {
  column: string;
  label: string;
  kind: Kind;
}

/**
 * Columnas que valen un aviso. Lo demás (CTIMESTAMP, usuario que capturó,
 * anchos de impresión…) cambia sin que a Finanzas le importe y publicarlo en
 * silencio es lo correcto.
 */
export const SIGNIFICANT_COLUMNS: Readonly<
  Record<string, readonly SignificantColumn[]>
> = {
  admDocumentos: [
    { column: 'CCANCELADO', label: 'Cancelado', kind: 'flag' },
    { column: 'CTOTAL', label: 'Total', kind: 'number' },
    { column: 'CNETO', label: 'Neto', kind: 'number' },
    { column: 'CIMPUESTO1', label: 'Impuesto', kind: 'number' },
    { column: 'CFECHA', label: 'Fecha', kind: 'date' },
    // CSERIEDOCUMENTO, CFOLIO y CREFERENCIA NO están aquí a propósito. Son la
    // identidad del documento tal como la muestra la app, no afectan montos ni
    // vínculos, y en el bootstrap del 2026-10-08 produjeron 251 de 260
    // retenciones falsas: la carga histórica de la app había perdido ceros a
    // la izquierda ('02686' → '2686') y precisión en folios largos. Esos
    // valores se publican en silencio: el ERP es la fuente de verdad.
    { column: 'CIDCONCEPTODOCUMENTO', label: 'Concepto (id)', kind: 'number' },
    { column: 'CRAZONSOCIAL', label: 'Razón social', kind: 'text' },
    { column: 'CRFC', label: 'RFC', kind: 'text' },
    { column: 'COBSERVACIONES', label: 'Observaciones', kind: 'text' },
    { column: 'CTEXTOEXTRA1', label: 'Texto extra 1', kind: 'text' },
    { column: 'CTEXTOEXTRA2', label: 'Unidad (texto extra 2)', kind: 'text' },
    {
      column: 'CTEXTOEXTRA3',
      label: 'Folio del sistema (texto extra 3)',
      kind: 'text',
    },
  ],
  admMovimientos: [
    { column: 'CIDPRODUCTO', label: 'Producto (id)', kind: 'number' },
    { column: 'CUNIDADES', label: 'Unidades', kind: 'number' },
    { column: 'CPRECIO', label: 'Precio', kind: 'number' },
    { column: 'CNETO', label: 'Neto', kind: 'number' },
    { column: 'CTOTAL', label: 'Total', kind: 'number' },
    { column: 'CIDALMACEN', label: 'Almacén (id)', kind: 'number' },
    { column: 'CTEXTOEXTRA1', label: 'Unidad (texto extra 1)', kind: 'text' },
    { column: 'COBSERVAMOV', label: 'Observaciones', kind: 'text' },
  ],
};

/** Tablas cuyas filas pueden retenerse. Las demás se publican siempre. */
export function canBeHeld(erpTable: string): boolean {
  return erpTable in SIGNIFICANT_COLUMNS;
}

const isBlank = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '');

function asText(v: unknown): string | null {
  if (isBlank(v)) return null;
  return typeof v === 'string' ? v.trim() : String(v);
}

function asNumber(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Solo la parte de fecha: la app guarda `timestamp` sin zona y el raw trae ISO con Z. */
function asDate(v: unknown): string | null {
  if (isBlank(v)) return null;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // Centinela de AdminPAQ para "sin fecha".
  if (s.startsWith('1899-12-30')) return null;
  return s.slice(0, 10);
}

function normalizeFor(kind: Kind, v: unknown): string | number | null {
  switch (kind) {
    case 'date':
      return asDate(v);
    case 'number':
      return asNumber(v);
    case 'flag':
      return asNumber(v) ?? 0;
    case 'text':
      return asText(v);
  }
}

function equal(
  kind: Kind,
  a: string | number | null,
  b: string | number | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (kind === 'number' || kind === 'flag') {
    // Hasta un centavo de diferencia es redondeo, no cambio: la carga
    // histórica de la app guardó montos a 2 decimales y el ERP trae 3
    // (91999.994 vs 92000).
    return Math.abs(Number(a) - Number(b)) <= 0.01;
  }
  return a === b;
}

/**
 * Traduce una fila de la app (columnas snake_case) a nombres del ERP, para
 * compararla contra el raw de staging con el mismo vocabulario.
 */
export function appRowToErp(
  appRow: Record<string, unknown>,
  columns: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [erpColumn, appColumn] of Object.entries(columns)) {
    out[erpColumn] = appRow[appColumn];
  }
  return out;
}

/** Valores listos para escribir en la app: { columna_app: valor }. */
export function rawToAppValues(
  raw: NormalizedRow,
  columns: Readonly<Record<string, string>>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [erpColumn, appColumn] of Object.entries(columns)) {
    out[appColumn] = raw[erpColumn] ?? null;
  }
  return out;
}

/**
 * Diferencias significativas entre lo que la app tiene (`before`, ya en
 * vocabulario ERP) y lo que el ERP trae (`after`). Vacío = nada que avisar.
 */
export function buildDiff(
  erpTable: string,
  before: Record<string, unknown> | null,
  after: NormalizedRow | null,
  movementId?: number,
): DiffEntry[] {
  const columns = SIGNIFICANT_COLUMNS[erpTable] ?? [];
  const entries: DiffEntry[] = [];

  if (after === null) {
    // Borrado físico en el ERP: una sola entrada, sin campo por campo.
    entries.push({
      column: '*',
      label: movementId
        ? 'Línea eliminada en el ERP'
        : 'Documento eliminado en el ERP',
      before: 'existe',
      after: 'no existe',
      ...(movementId ? { movement_id: movementId } : {}),
    });
    return entries;
  }

  if (before === null) {
    // La app no tiene la fila (línea nueva en un documento ya vinculado).
    entries.push({
      column: '*',
      label: movementId ? 'Línea nueva en el ERP' : 'Documento nuevo en el ERP',
      before: 'no existe',
      after: 'existe',
      ...(movementId ? { movement_id: movementId } : {}),
    });
    return entries;
  }

  for (const { column, label, kind } of columns) {
    const a = normalizeFor(kind, before[column]);
    const b = normalizeFor(kind, after[column]);
    if (!equal(kind, a, b)) {
      entries.push({
        column,
        label,
        before: a,
        after: b,
        ...(movementId ? { movement_id: movementId } : {}),
      });
    }
  }

  return entries;
}

/** Cómo se llama el cambio para la app. */
export function classifyChange(
  diff: readonly DiffEntry[],
  documentDeleted: boolean,
): ChangeType {
  if (documentDeleted) return 'deleted';
  const cancel = diff.find((d) => d.column === 'CCANCELADO' && !d.movement_id);
  if (cancel && Number(cancel.after) === 1 && Number(cancel.before) !== 1)
    return 'cancelled';
  return 'modified';
}
