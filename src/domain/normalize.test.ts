import { describe, it, expect } from 'vitest';
import { extractEcoNumbers, extractFolios, parseAdminPaqTimestamp } from './normalize';

describe('extractEcoNumbers', () => {
  it('normaliza un eco limpio', () => {
    const r = extractEcoNumbers('AP-045');
    expect(r.ecoNumbers).toEqual(['AP-045']);
    expect(r.confidence).toBe('high');
  });

  it('rellena con ceros los ecos cortos', () => {
    expect(extractEcoNumbers('tp-1').ecoNumbers).toEqual(['TP-001']);
    expect(extractEcoNumbers('ap-11').ecoNumbers).toEqual(['AP-011']);
    expect(extractEcoNumbers('TP-01').ecoNumbers).toEqual(['TP-001']);
  });

  it('extrae el eco embebido en texto libre', () => {
    const r = extractEcoNumbers('AP-119 COSTO X KILOMETRO');
    expect(r.ecoNumbers).toEqual(['AP-119']);
    expect(r.confidence).toBe('medium');
  });

  // Caso real: imagen 3, documento FP10181
  it('detecta varias unidades en un mismo campo', () => {
    const r = extractEcoNumbers('AP-035, AP-100 STOCK');
    expect(r.ecoNumbers).toEqual(['AP-035', 'AP-100']);
    expect(r.mentionsStock).toBe(true);
  });

  it('marca las menciones a stock/almacén', () => {
    expect(extractEcoNumbers('COMPRA STOCK').mentionsStock).toBe(true);
    expect(extractEcoNumbers('ALMACEN GENERAL').mentionsStock).toBe(true);
    expect(extractEcoNumbers('AP-087').mentionsStock).toBe(false);
  });

  it('devuelve vacío cuando no hay nada que extraer', () => {
    expect(extractEcoNumbers(null).ecoNumbers).toEqual([]);
    expect(extractEcoNumbers('').ecoNumbers).toEqual([]);
    expect(extractEcoNumbers('   ').ecoNumbers).toEqual([]);
    expect(extractEcoNumbers('SIN UNIDAD').ecoNumbers).toEqual([]);
  });

  it('no duplica el mismo eco repetido', () => {
    expect(extractEcoNumbers('AP-087 Y AP-087').ecoNumbers).toEqual(['AP-087']);
  });
});

describe('extractFolios', () => {
  it('reconoce un folio de mantenimiento con prefijo', () => {
    const r = extractFolios('M-260511-1');
    expect(r.candidates).toEqual([
      { pid: 'M-260511-1', kind: 'maintenance', origin: 'exact' },
    ]);
    expect(r.ambiguous).toBe(false);
    expect(r.multiple).toBe(false);
  });

  it('reconoce un folio de siniestro con prefijo', () => {
    const r = extractFolios('S-260511-3');
    expect(r.candidates[0]).toEqual({
      pid: 'S-260511-3',
      kind: 'accident',
      origin: 'exact',
    });
  });

  // Caso real: imagen 1 y 3 — la mayoría de folios vienen así
  it('genera ambos candidatos cuando el folio no trae prefijo', () => {
    const r = extractFolios('260715-29');
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.pid)).toEqual(['M-260715-29', 'S-260715-29']);
  });

  it('tolera el doble guión de captura', () => {
    const r = extractFolios('M--250814-54');
    expect(r.candidates[0].pid).toBe('M-250814-54');
    expect(r.candidates[0].origin).toBe('exact');
  });

  it('separa folios múltiples', () => {
    const r = extractFolios('M-250922-54 / M-250909-72');
    expect(r.multiple).toBe(true);
    expect(r.candidates.map((c) => c.pid)).toEqual(['M-250922-54', 'M-250909-72']);
  });

  it('acepta coma y punto y coma como separadores', () => {
    expect(extractFolios('M-250922-54, M-250909-72').candidates).toHaveLength(2);
    expect(extractFolios('M-250922-54; M-250909-72').candidates).toHaveLength(2);
  });

  // Caso real: imagen 3, columna "Folio ERP" de FP10181
  it('maneja folios múltiples separados por espacios', () => {
    const r = extractFolios('260602-94  260611-5');
    expect(r.multiple).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.pid)).toContain('M-260602-94');
    expect(r.candidates.map((c) => c.pid)).toContain('M-260611-5');
  });

  it('devuelve vacío cuando no hay folio', () => {
    expect(extractFolios(null).candidates).toEqual([]);
    expect(extractFolios('').candidates).toEqual([]);
    expect(extractFolios('SIN FOLIO').candidates).toEqual([]);
  });
});

describe('parseAdminPaqTimestamp', () => {
  it('parsea el formato MM/DD/YYYY de AdminPAQ', () => {
    const d = parseAdminPaqTimestamp('07/23/2026 14:05:00:000');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6); // julio
    expect(d!.getDate()).toBe(23);
  });

  it('trata el centinela 12/30/1899 como nulo', () => {
    expect(parseAdminPaqTimestamp('12/30/1899 00:00:00:000')).toBeNull();
  });

  it('acepta fecha sin hora', () => {
    const d = parseAdminPaqTimestamp('01/15/2026');
    expect(d).not.toBeNull();
    expect(d!.getDate()).toBe(15);
  });

  it('devuelve null ante basura', () => {
    expect(parseAdminPaqTimestamp(null)).toBeNull();
    expect(parseAdminPaqTimestamp('')).toBeNull();
    expect(parseAdminPaqTimestamp('no es fecha')).toBeNull();
  });
});
