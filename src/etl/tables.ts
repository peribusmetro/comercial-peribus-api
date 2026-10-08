import { parseAdminPaqTimestamp } from '../domain/normalize';
import {
  ALMACENES_COLUMNS,
  CONCEPTOS_COLUMNS,
  COSTOSHISTORICOS_COLUMNS,
  DOCUMENTOS_COLUMNS,
  EXISTENCIACOSTO_COLUMNS,
  FOLIOSDIGITALES_COLUMNS,
  MOVIMIENTOS_COLUMNS,
  PRECIOSCOMPRA_COLUMNS,
  PRODUCTOS_COLUMNS,
} from './column-maps';

/**
 * Registro de las 9 tablas que viajan AdminPAQ → staging → app.
 *
 * Cada entrada dice de dónde se lee (ERP), dónde se guarda aquí (staging),
 * a dónde se publica (app) y cómo se detectan cambios. El motor de ingesta
 * (`ingest.ts`) y el publicador no saben de tablas concretas: solo recorren
 * este registro.
 */

/** Fila cruda del ERP: nombres de columna originales de AdminPAQ. */
export type RawRow = Record<string, unknown>;

export interface TableDef {
  /** Nombre en SQL Server (admDocumentos). */
  erpTable: string;
  /** Clave primaria en el ERP (CIDDOCUMENTO). */
  erpKey: string;
  /** Tabla de staging en la base del validador (adm_documents). */
  staging: string;
  /** Clave en staging y en la app (document_id). */
  key: string;
  /** Tabla destino en la base de la app (comercial_adm_documents). */
  appTable: string;
  /**
   * Si el ERP mantiene CTIMESTAMP válido en esta tabla. Cuando sí, además de
   * los ids faltantes se traen las filas modificadas desde el último
   * timestamp conocido. Cuando no, solo se detectan filas nuevas por id (y
   * las que se refrescan por su tabla padre).
   */
  hasTimestamp: boolean;
  /** Columna ERP → columna app. También define qué se lee y qué entra al hash. */
  columns: Readonly<Record<string, string>>;
  /**
   * Columnas tipadas de staging (las que usan las reglas), derivadas de la
   * fila cruda. Las tablas sin reglas no las tienen: solo guardan `raw`.
   */
  typed?: (raw: RawRow) => Record<string, unknown>;
  /**
   * Columnas de texto libre que AdminPAQ edita SIN tocar CTIMESTAMP. Se
   * re-leen completas en cada corrida y se comparan contra `raw` para
   * detectar el cambio (es lo que hacía sync-update-extra-fields.mjs).
   */
  driftColumns?: readonly string[];
  /**
   * Tabla padre: cuando cambia una fila del padre se refrescan sus hijas,
   * porque la tabla hija no tiene CTIMESTAMP (movimientos por documento).
   */
  parent?: { erpColumn: string; erpTable: string };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim() || null : v == null ? null : String(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' ? v : v == null || v === '' ? null : Number(v);
const date = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const TABLES: readonly TableDef[] = [
  {
    erpTable: 'admDocumentos',
    erpKey: 'CIDDOCUMENTO',
    staging: 'adm_documents',
    key: 'document_id',
    appTable: 'comercial_adm_documents',
    hasTimestamp: true,
    columns: DOCUMENTOS_COLUMNS,
    driftColumns: ['CTEXTOEXTRA1', 'CTEXTOEXTRA2', 'CTEXTOEXTRA3'],
    typed: (raw) => ({
      document_concept_id: num(raw.CIDCONCEPTODOCUMENTO),
      document_series: str(raw.CSERIEDOCUMENTO),
      folio: num(raw.CFOLIO),
      date: date(raw.CFECHA),
      client_supplier_id: num(raw.CIDCLIENTEPROVEEDOR),
      business_name: str(raw.CRAZONSOCIAL),
      rfc: str(raw.CRFC),
      reference: str(raw.CREFERENCIA),
      observations: str(raw.COBSERVACIONES),
      nature: num(raw.CNATURALEZA),
      cancelled: num(raw.CCANCELADO) ?? 0,
      net_amount: num(raw.CNETO),
      tax_one: num(raw.CIMPUESTO1),
      total: num(raw.CTOTAL),
      currency_id: num(raw.CIDMONEDA),
      exchange_rate: num(raw.CTIPOCAMBIO),
      username: str(raw.CUSUARIO),
      extra_text_one: str(raw.CTEXTOEXTRA1),
      extra_text_two: str(raw.CTEXTOEXTRA2),
      extra_text_three: str(raw.CTEXTOEXTRA3),
      sql_timestamp: str(raw.CTIMESTAMP),
      sql_timestamp_parsed:
        parseAdminPaqTimestamp(str(raw.CTIMESTAMP))?.toISOString() ?? null,
    }),
  },
  {
    erpTable: 'admMovimientos',
    erpKey: 'CIDMOVIMIENTO',
    staging: 'adm_movements',
    key: 'movement_id',
    appTable: 'comercial_adm_movements',
    hasTimestamp: false,
    columns: MOVIMIENTOS_COLUMNS,
    parent: { erpColumn: 'CIDDOCUMENTO', erpTable: 'admDocumentos' },
    typed: (raw) => ({
      document_id: num(raw.CIDDOCUMENTO) ?? 0,
      movement_number: num(raw.CNUMEROMOVIMIENTO),
      product_id: num(raw.CIDPRODUCTO),
      warehouse_id: num(raw.CIDALMACEN),
      units: num(raw.CUNIDADES),
      price: num(raw.CPRECIO),
      net_amount: num(raw.CNETO),
      total: num(raw.CTOTAL),
      reference: str(raw.CREFERENCIA),
      observations: str(raw.COBSERVAMOV),
      date: date(raw.CFECHA),
      extra_text_one: str(raw.CTEXTOEXTRA1),
    }),
  },
  {
    erpTable: 'admProductos',
    erpKey: 'CIDPRODUCTO',
    staging: 'adm_products',
    key: 'product_id',
    appTable: 'comercial_adm_products',
    hasTimestamp: false,
    columns: PRODUCTOS_COLUMNS,
    typed: (raw) => ({
      product_code: str(raw.CCODIGOPRODUCTO),
      product_name: str(raw.CNOMBREPRODUCTO),
      product_type: num(raw.CTIPOPRODUCTO),
      status: num(raw.CSTATUSPRODUCTO),
      description: str(raw.CDESCRIPCIONPRODUCTO),
      sat_key: str(raw.CCLAVESAT),
      price_one: num(raw.CPRECIO1),
      base_unit_id: num(raw.CIDUNIDADBASE),
    }),
  },
  {
    erpTable: 'admConceptos',
    erpKey: 'CIDCONCEPTODOCUMENTO',
    staging: 'adm_concepts',
    key: 'concept_id',
    appTable: 'comercial_adm_concepts',
    hasTimestamp: false,
    columns: CONCEPTOS_COLUMNS,
    typed: (raw) => ({
      concept_code: str(raw.CCODIGOCONCEPTO),
      concept_name: str(raw.CNOMBRECONCEPTO),
      nature: num(raw.CNATURALEZA),
      folio_type: num(raw.CTIPOFOLIO),
    }),
  },
  {
    erpTable: 'admExistenciaCosto',
    erpKey: 'CIDEXISTENCIA',
    staging: 'adm_stock_costs',
    key: 'stock_id',
    appTable: 'comercial_adm_stock_costs',
    hasTimestamp: true,
    columns: EXISTENCIACOSTO_COLUMNS,
  },
  {
    erpTable: 'admFoliosDigitales',
    erpKey: 'CIDFOLDIG',
    staging: 'adm_digital_stamps',
    key: 'digital_stamp_id',
    appTable: 'comercial_adm_digital_stamps',
    hasTimestamp: false,
    columns: FOLIOSDIGITALES_COLUMNS,
  },
  {
    erpTable: 'admCostosHistoricos',
    erpKey: 'CIDCOSTOH',
    staging: 'adm_historical_costs',
    key: 'historical_cost_id',
    appTable: 'comercial_adm_historical_costs',
    hasTimestamp: true,
    columns: COSTOSHISTORICOS_COLUMNS,
  },
  {
    erpTable: 'admAlmacenes',
    erpKey: 'CIDALMACEN',
    staging: 'adm_warehouses',
    key: 'warehouse_id',
    appTable: 'comercial_adm_warehouses',
    hasTimestamp: true,
    columns: ALMACENES_COLUMNS,
  },
  {
    erpTable: 'admPreciosCompra',
    erpKey: 'CIDAUTOINCSQL',
    staging: 'adm_purchase_prices',
    key: 'purchase_price_id',
    appTable: 'comercial_adm_purchase_prices',
    hasTimestamp: true,
    columns: PRECIOSCOMPRA_COLUMNS,
  },
];

/** Busca una tabla por nombre ERP, de staging o de la app (sin distinguir mayúsculas). */
export function findTable(name: string): TableDef | undefined {
  const needle = name.trim().toLowerCase();
  return TABLES.find(
    (t) =>
      t.erpTable.toLowerCase() === needle ||
      t.staging === needle ||
      t.appTable === needle,
  );
}

/**
 * Resuelve una lista de nombres a definiciones, conservando el orden del
 * registro (los padres van antes que sus hijas). Lanza si un nombre no existe.
 */
export function resolveTables(names?: readonly string[]): TableDef[] {
  if (!names || names.length === 0) return [...TABLES];

  const wanted = new Set<TableDef>();
  for (const name of names) {
    const def = findTable(name);
    if (!def) {
      throw new Error(
        `Tabla desconocida: "${name}". Válidas: ${TABLES.map((t) => t.erpTable).join(', ')}`,
      );
    }
    wanted.add(def);
  }
  return TABLES.filter((t) => wanted.has(t));
}
