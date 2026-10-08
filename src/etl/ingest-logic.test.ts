import { describe, expect, it } from 'vitest';
import {
  buildRaw,
  findDriftedIds,
  hashRaw,
  normalizeValue,
  partitionIds,
} from './ingest-logic';

describe('normalizeValue / buildRaw / hashRaw', () => {
  it('serializa fechas a ISO y vuelve null lo ausente', () => {
    expect(normalizeValue(new Date('2026-10-08T06:00:00Z'))).toBe(
      '2026-10-08T06:00:00.000Z',
    );
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(12.5)).toBe(12.5);
    expect(normalizeValue('AP-087 ')).toBe('AP-087 ');
  });

  it('solo conserva las columnas del mapa, en el orden del mapa', () => {
    const columns = { CIDDOCUMENTO: 'document_id', CTOTAL: 'total' } as const;
    const raw = buildRaw(
      { CTOTAL: 10, CIDDOCUMENTO: 7, CBASURA: 'x' },
      columns,
    );
    expect(Object.keys(raw)).toEqual(['CIDDOCUMENTO', 'CTOTAL']);
    expect(raw).toEqual({ CIDDOCUMENTO: 7, CTOTAL: 10 });
  });

  it('la huella es estable ante el orden de llegada y cambia con cualquier columna', () => {
    const columns = {
      CIDDOCUMENTO: 'document_id',
      CTOTAL: 'total',
      CTEXTOEXTRA3: 'x',
    } as const;
    const a = hashRaw(
      buildRaw({ CIDDOCUMENTO: 1, CTOTAL: 5, CTEXTOEXTRA3: 'M-1' }, columns),
    );
    const b = hashRaw(
      buildRaw({ CTEXTOEXTRA3: 'M-1', CTOTAL: 5, CIDDOCUMENTO: 1 }, columns),
    );
    const c = hashRaw(
      buildRaw({ CIDDOCUMENTO: 1, CTOTAL: 5, CTEXTOEXTRA3: 'M-2' }, columns),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(40);
  });

  it('una columna que el ERP deja de devolver no altera la huella (undefined = null)', () => {
    const columns = { CIDDOCUMENTO: 'document_id', CRFC: 'rfc' } as const;
    const a = hashRaw(buildRaw({ CIDDOCUMENTO: 1, CRFC: null }, columns));
    const b = hashRaw(buildRaw({ CIDDOCUMENTO: 1 }, columns));
    expect(a).toBe(b);
  });
});

describe('partitionIds', () => {
  it('detecta faltantes, borrados, resucitados y filas sin raw', () => {
    const erp = [1, 2, 3, 5];
    const staging = [
      { id: 1, deleted: false, hydrated: true }, // igual
      { id: 2, deleted: false, hydrated: false }, // anterior a la migración: re-traer
      { id: 3, deleted: true, hydrated: true }, // reapareció en el ERP
      { id: 4, deleted: false, hydrated: true }, // ya no está en el ERP
      { id: 6, deleted: true, hydrated: true }, // borrado y sigue borrado: nada
    ];
    const r = partitionIds(erp, staging);
    expect(r.toFetch.sort()).toEqual([2, 3, 5]);
    expect(r.toDeactivate).toEqual([4]);
    expect(r.resurrected).toEqual([3]);
  });
});

describe('findDriftedIds', () => {
  const cols = ['CTEXTOEXTRA1', 'CTEXTOEXTRA2', 'CTEXTOEXTRA3'];

  it('marca los documentos cuyo texto libre cambió, ignorando espacios', () => {
    const erp = [
      {
        CIDDOCUMENTO: 1,
        CTEXTOEXTRA1: 'AP-1',
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: 'M-260101-1',
      },
      {
        CIDDOCUMENTO: 2,
        CTEXTOEXTRA1: null,
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: 'M-260101-2 ',
      },
    ];
    const staging = [
      {
        CIDDOCUMENTO: 1,
        CTEXTOEXTRA1: 'AP-1',
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: 'M-260101-9',
      },
      {
        CIDDOCUMENTO: 2,
        CTEXTOEXTRA1: null,
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: 'M-260101-2',
      },
    ];
    expect(findDriftedIds(erp, staging, 'CIDDOCUMENTO', cols)).toEqual([1]);
  });

  it('un documento al que le borraron todo el texto en el ERP también se refresca', () => {
    const erp: Record<string, unknown>[] = [];
    const staging = [
      {
        CIDDOCUMENTO: 7,
        CTEXTOEXTRA1: null,
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: 'M-1',
      },
      {
        CIDDOCUMENTO: 8,
        CTEXTOEXTRA1: null,
        CTEXTOEXTRA2: null,
        CTEXTOEXTRA3: null,
      },
    ];
    expect(findDriftedIds(erp, staging, 'CIDDOCUMENTO', cols)).toEqual([7]);
  });
});
