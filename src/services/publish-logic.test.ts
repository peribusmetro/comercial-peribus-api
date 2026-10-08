import { describe, expect, it } from 'vitest';
import {
  appRowToErp,
  buildDiff,
  canBeHeld,
  classifyChange,
  rawToAppValues,
} from './publish-logic';

describe('buildDiff', () => {
  const before = {
    CCANCELADO: 0,
    CTOTAL: 12500,
    CNETO: 10775.86,
    CIMPUESTO1: 1724.14,
    CFECHA: '2026-10-01 00:00:00',
    CSERIEDOCUMENTO: 'COMDU',
    CFOLIO: 7480,
    CIDCONCEPTODOCUMENTO: 5,
    CRAZONSOCIAL: 'REFACCIONES DEL NORTE ',
    CRFC: 'RDN010101AAA',
    CREFERENCIA: null,
    COBSERVACIONES: '',
    CTEXTOEXTRA1: 'AP-041',
    CTEXTOEXTRA2: 'NORTE AP-041',
    CTEXTOEXTRA3: 'M-261001-7',
    CTIMESTAMP: '10/01/2026 09:00:00:000',
    CUSUARIO: 'compras',
  };

  it('no avisa cuando solo cambiaron columnas sin importancia o el formato', () => {
    const after = {
      ...before,
      CRAZONSOCIAL: 'REFACCIONES DEL NORTE', // sin espacio final
      CFECHA: '2026-10-01T00:00:00.000Z', // ISO con Z vs timestamp sin zona
      COBSERVACIONES: null, // '' y null son lo mismo
      CTIMESTAMP: '10/05/2026 11:00:00:000', // no es significativa
      CUSUARIO: 'otro',
      CTOTAL: 12500.004, // tolerancia de centavos
    };
    expect(buildDiff('admDocumentos', before, after)).toEqual([]);
  });

  it('serie, folio ERP y referencia no retienen; un centavo de redondeo tampoco', () => {
    const after = {
      ...before,
      CSERIEDOCUMENTO: '0COMDU',
      CFOLIO: 7480.5,
      CREFERENCIA: '00128',
      CTOTAL: 12500.006,
      CNETO: 10775.855,
    };
    expect(buildDiff('admDocumentos', before, after)).toEqual([]);
  });

  it('detecta cancelación y la clasifica', () => {
    const diff = buildDiff('admDocumentos', before, {
      ...before,
      CCANCELADO: 1,
    });
    expect(diff).toEqual([
      { column: 'CCANCELADO', label: 'Cancelado', before: 0, after: 1 },
    ]);
    expect(classifyChange(diff, false)).toBe('cancelled');
  });

  it('detecta cambio de monto y de folio del sistema como modificado', () => {
    const diff = buildDiff('admDocumentos', before, {
      ...before,
      CTOTAL: 13000,
      CTEXTOEXTRA3: 'M-261001-9',
    });
    expect(diff.map((d) => d.column)).toEqual(['CTOTAL', 'CTEXTOEXTRA3']);
    expect(diff[1]).toMatchObject({
      before: 'M-261001-7',
      after: 'M-261001-9',
    });
    expect(classifyChange(diff, false)).toBe('modified');
  });

  it('borrado en el ERP: una sola entrada y tipo deleted', () => {
    const diff = buildDiff('admDocumentos', before, null);
    expect(diff).toHaveLength(1);
    expect(diff[0].after).toBe('no existe');
    expect(classifyChange(diff, true)).toBe('deleted');
  });

  it('líneas de movimiento llevan movement_id y no cuentan como cancelación', () => {
    const mBefore = {
      CIDPRODUCTO: 10,
      CUNIDADES: 2,
      CPRECIO: 100,
      CNETO: 200,
      CTOTAL: 232,
      CIDALMACEN: 1,
      CTEXTOEXTRA1: 'AP-041',
      CREFERENCIA: null,
      COBSERVAMOV: null,
    };
    const diff = buildDiff(
      'admMovimientos',
      mBefore,
      { ...mBefore, CUNIDADES: 3, CTOTAL: 348 },
      77,
    );
    expect(diff).toEqual([
      {
        column: 'CUNIDADES',
        label: 'Unidades',
        before: 2,
        after: 3,
        movement_id: 77,
      },
      {
        column: 'CTOTAL',
        label: 'Total',
        before: 232,
        after: 348,
        movement_id: 77,
      },
    ]);
    expect(classifyChange(diff, false)).toBe('modified');
    expect(buildDiff('admMovimientos', null, mBefore, 78)[0]).toMatchObject({
      label: 'Línea nueva en el ERP',
      movement_id: 78,
    });
  });

  it('el centinela 1899-12-30 cuenta como sin fecha', () => {
    const diff = buildDiff(
      'admDocumentos',
      { ...before, CFECHA: '1899-12-30 00:00:00' },
      { ...before, CFECHA: null },
    );
    expect(diff).toEqual([]);
  });
});

describe('mapeos app ↔ ERP', () => {
  const columns = {
    CIDDOCUMENTO: 'document_id',
    CTOTAL: 'total',
    CTEXTOEXTRA3: 'extra_text_three',
  } as const;

  it('appRowToErp invierte el mapa', () => {
    expect(
      appRowToErp(
        { document_id: 1, total: 5, extra_text_three: 'M-1', otra: 'x' },
        columns,
      ),
    ).toEqual({
      CIDDOCUMENTO: 1,
      CTOTAL: 5,
      CTEXTOEXTRA3: 'M-1',
    });
  });

  it('rawToAppValues produce solo columnas de la app y rellena null', () => {
    expect(rawToAppValues({ CIDDOCUMENTO: 1, CTOTAL: 5 }, columns)).toEqual({
      document_id: 1,
      total: 5,
      extra_text_three: null,
    });
  });

  it('solo documentos y movimientos pueden retenerse', () => {
    expect(canBeHeld('admDocumentos')).toBe(true);
    expect(canBeHeld('admMovimientos')).toBe(true);
    expect(canBeHeld('admProductos')).toBe(false);
    expect(canBeHeld('admConceptos')).toBe(false);
  });
});
