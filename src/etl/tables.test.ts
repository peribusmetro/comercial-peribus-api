import { describe, expect, it } from 'vitest';
import { buildRaw } from './ingest-logic';
import { findTable, resolveTables, TABLES } from './tables';

/**
 * Protege el contrato entre el mapa de columnas (qué se lee del ERP) y las
 * columnas tipadas que usan las reglas. El 2026-10-08 el mapa portado del
 * Action no traía CTEXTOEXTRA1-3 y las reglas se quedaron sin unidad ni folio.
 */
describe('registro de tablas', () => {
  it('tiene las 9 tablas que lee la app, padres antes que hijas', () => {
    expect(TABLES.map((t) => t.appTable)).toEqual([
      'comercial_adm_documents',
      'comercial_adm_movements',
      'comercial_adm_products',
      'comercial_adm_concepts',
      'comercial_adm_stock_costs',
      'comercial_adm_digital_stamps',
      'comercial_adm_historical_costs',
      'comercial_adm_warehouses',
      'comercial_adm_purchase_prices',
    ]);
    const docs = TABLES.findIndex((t) => t.erpTable === 'admDocumentos');
    const movs = TABLES.findIndex((t) => t.erpTable === 'admMovimientos');
    expect(docs).toBeLessThan(movs);
  });

  it('cada mapa incluye su clave y, si tiene CTIMESTAMP, lo mapea', () => {
    for (const t of TABLES) {
      expect(Object.keys(t.columns)).toContain(t.erpKey);
      expect(t.columns[t.erpKey]).toBe(t.key);
      if (t.hasTimestamp)
        expect(Object.keys(t.columns)).toContain('CTIMESTAMP');
    }
  });

  it('las columnas tipadas de las reglas salen del raw, no quedan en null', () => {
    const docs = findTable('admDocumentos')!;
    const row: Record<string, unknown> = {};
    for (const c of Object.keys(docs.columns)) row[c] = `v_${c}`;
    row.CIDDOCUMENTO = 1;
    row.CCANCELADO = 0;
    row.CTIMESTAMP = '10/08/2026 01:30:00:000';
    const typed = docs.typed!(buildRaw(row, docs.columns));
    expect(typed.extra_text_one).toBe('v_CTEXTOEXTRA1');
    expect(typed.extra_text_two).toBe('v_CTEXTOEXTRA2');
    expect(typed.extra_text_three).toBe('v_CTEXTOEXTRA3');
    expect(typed.sql_timestamp).toBe('10/08/2026 01:30:00:000');

    const movs = findTable('admMovimientos')!;
    const mrow: Record<string, unknown> = {};
    for (const c of Object.keys(movs.columns)) mrow[c] = `v_${c}`;
    mrow.CIDMOVIMIENTO = 1;
    mrow.CIDDOCUMENTO = 2;
    const mtyped = movs.typed!(buildRaw(mrow, movs.columns));
    expect(mtyped.extra_text_one).toBe('v_CTEXTOEXTRA1');
    expect(mtyped.document_id).toBe(2);
  });

  it('las columnas de deriva de documentos están en su mapa', () => {
    const docs = findTable('admDocumentos')!;
    for (const c of docs.driftColumns ?? []) {
      expect(Object.keys(docs.columns)).toContain(c);
    }
  });

  it('resuelve nombres ERP, staging o app y rechaza desconocidos', () => {
    expect(
      resolveTables(['comercial_adm_concepts', 'ADMALMACENES']).map(
        (t) => t.erpTable,
      ),
    ).toEqual(['admConceptos', 'admAlmacenes']);
    expect(() => resolveTables(['admNada'])).toThrow(/Tabla desconocida/);
  });
});
