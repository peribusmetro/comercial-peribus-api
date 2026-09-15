/**
 * Normalizadores de los campos libres de AdminPAQ.
 *
 * Los operadores capturan a mano, así que el mismo dato llega de muchas
 * formas: "tp-1", "TP-001", "M--250814-54", "260715-29", "AP-119 COSTO X KM".
 *
 * La lógica replica la de peribus-incidents-admin
 * (features/comercial/utils/{eco-number-extractor,folio-detector}.ts) para que
 * el validador y la app entiendan lo mismo. Si se cambia aquí, hay que
 * cambiarlo allá.
 */

/** Prefijos de unidad válidos en la flota. */
const ECO_PREFIXES = ['AP', 'TP', 'TR', 'AR', 'PR'] as const;
const ECO_PREFIX_GROUP = ECO_PREFIXES.join('|');

// 1 a 3 dígitos: en el ERP se captura "tp-1", "ap-11" y "AP-045" indistintamente.
const ECO_EXACT = new RegExp(`^(${ECO_PREFIX_GROUP})-(\\d{1,3})$`, 'i');
const ECO_IN_TEXT = new RegExp(`(${ECO_PREFIX_GROUP})-(\\d{1,3})`, 'gi');

/** Palabras que marcan una compra a inventario, no a una unidad. */
const STOCK_KEYWORDS = ['STOCK', 'ALMACEN', 'ALMACÉN', 'INVENTARIO'];

export type EcoConfidence = 'high' | 'medium';

export interface EcoExtraction {
  /** Ecos detectados, ya normalizados a PREFIJO-NNN. Sin duplicados. */
  ecoNumbers: string[];
  confidence: EcoConfidence;
  /** El texto menciona explícitamente stock/almacén. */
  mentionsStock: boolean;
}

/**
 * Extrae los números económicos de un texto libre.
 *
 * Devuelve TODOS los encontrados, no solo el primero: un documento con
 * "AP-035, AP-100 STOCK" debe delatar que trae dos unidades (regla R3).
 */
export function extractEcoNumbers(value: string | null | undefined): EcoExtraction {
  const empty: EcoExtraction = { ecoNumbers: [], confidence: 'medium', mentionsStock: false };

  if (!value || !value.trim()) return empty;

  const text = value.trim().toUpperCase();
  const mentionsStock = STOCK_KEYWORDS.some((kw) => text.includes(kw));

  // Caso limpio: el campo trae exactamente un eco y nada más.
  const exact = text.match(ECO_EXACT);
  if (exact) {
    return {
      ecoNumbers: [`${exact[1]}-${exact[2].padStart(3, '0')}`],
      confidence: 'high',
      mentionsStock,
    };
  }

  // Caso sucio: uno o más ecos embebidos en texto libre.
  const found = new Set<string>();
  for (const match of text.matchAll(ECO_IN_TEXT)) {
    found.add(`${match[1]}-${match[2].padStart(3, '0')}`);
  }

  return {
    ecoNumbers: [...found],
    confidence: found.size > 0 ? 'medium' : 'medium',
    mentionsStock,
  };
}

export type FolioKind = 'maintenance' | 'accident';

export interface FolioCandidate {
  /** Folio normalizado: M-YYMMDD-N o S-YYMMDD-N */
  pid: string;
  kind: FolioKind;
  /** exact = traía prefijo; ambiguous = se dedujo, podría ser M o S */
  origin: 'exact' | 'ambiguous';
}

export interface FolioExtraction {
  candidates: FolioCandidate[];
  /** El texto traía más de un folio (ej. "M-250922-54 / M-250909-72"). */
  multiple: boolean;
  /** Ningún candidato trae prefijo: no se puede saber si es M o S. */
  ambiguous: boolean;
}

// Un folio es YYMMDD-N, con prefijo opcional y tolerando guiones repetidos.
const FOLIO_TOKEN = /(?:([MS])\s*-{1,2}\s*)?(\d{6})\s*-{1,2}\s*(\d{1,3})/gi;
const FOLIO_SEPARATORS = /[/,;|]+/;

/**
 * Extrae los folios de sistema de `extra_text_three`.
 *
 * Un folio sin prefijo ("260715-29") es ambiguo: podría ser mantenimiento o
 * siniestro. Se generan ambos candidatos y se marca `ambiguous`, para que
 * quien resuelva sepa que hubo una suposición de por medio.
 */
export function extractFolios(value: string | null | undefined): FolioExtraction {
  const empty: FolioExtraction = { candidates: [], multiple: false, ambiguous: false };

  if (!value || !value.trim()) return empty;

  const text = value.trim().toUpperCase();
  const chunks = text.split(FOLIO_SEPARATORS).filter((c) => c.trim());

  const candidates: FolioCandidate[] = [];
  const seen = new Set<string>();
  let rawCount = 0;
  let anyAmbiguous = false;

  const push = (pid: string, kind: FolioKind, origin: 'exact' | 'ambiguous') => {
    const key = `${pid}:${origin}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ pid, kind, origin });
  };

  for (const chunk of chunks) {
    for (const match of chunk.matchAll(FOLIO_TOKEN)) {
      const [, prefix, date, seq] = match;
      rawCount++;

      if (prefix === 'M') {
        push(`M-${date}-${seq}`, 'maintenance', 'exact');
      } else if (prefix === 'S') {
        push(`S-${date}-${seq}`, 'accident', 'exact');
      } else {
        // Sin prefijo: ambas lecturas son posibles.
        anyAmbiguous = true;
        push(`M-${date}-${seq}`, 'maintenance', 'ambiguous');
        push(`S-${date}-${seq}`, 'accident', 'ambiguous');
      }
    }
  }

  return {
    candidates,
    multiple: rawCount > 1,
    ambiguous: anyAmbiguous,
  };
}

/**
 * Parsea el CTIMESTAMP de AdminPAQ, que llega como texto MM/DD/YYYY HH:mm:ss:SSS.
 *
 * '12/30/1899 00:00:00:000' es el centinela de "sin valor" de AdminPAQ y se
 * trata como null.
 */
export function parseAdminPaqTimestamp(value: string | null | undefined): Date | null {
  if (!value || !value.trim()) return null;

  const text = value.trim();
  if (text.startsWith('12/30/1899')) return null;

  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/,
  );
  if (!match) return null;

  const [, mm, dd, yyyy, hh = '0', mi = '0', ss = '0'] = match;
  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  );

  return Number.isNaN(date.getTime()) ? null : date;
}
