import { appDb } from '@/db/clients';
import type { FolioContext, LinkType } from '@/domain/types';

/**
 * Resuelve folios contra el Supabase de la app.
 *
 * La unidad del folio es el otro lado de R1, y no vive en `maintenances`:
 * se llega por `maintenances.incident_id → incidents.unit_id → units`.
 * Es la misma cadena que usa la app en search-maintenances.ts, con LEFT JOIN
 * porque un mantenimiento puede no tener incidente asociado.
 *
 * Los siniestros quedan fuera por ahora: `accidents` está vacía (0 filas) y la
 * FK de comercial_document_links apunta ahí, así que ligar un siniestro falla.
 * Los siniestros reales viven en incident_types con pid 'S-%'. Habilitarlos
 * requiere una migración de FK del lado de la app.
 */

export interface FolioLookupResult {
  found: Map<string, FolioContext>;
  missing: string[];
}

/**
 * Busca varios folios de mantenimiento en una sola consulta.
 *
 * Se resuelve por lotes y no uno por uno: el validador evalúa decenas de miles
 * de documentos y una consulta por folio saturaría el pooler.
 */
export async function resolveMaintenanceFolios(pids: string[]): Promise<FolioLookupResult> {
  const unique = [...new Set(pids.filter((p) => p.startsWith('M-')))];

  if (unique.length === 0) {
    return { found: new Map(), missing: [] };
  }

  const rows = await appDb<
    {
      pid: string;
      maintenance_id: number;
      eco_number: string | null;
      created_at: Date | null;
    }[]
  >`
    SELECT
      m.pid            AS pid,
      m.id             AS maintenance_id,
      u.eco_number     AS eco_number,
      m.created_at     AS created_at
    FROM maintenances m
    LEFT JOIN incidents i ON i.id = m.incident_id
    LEFT JOIN units     u ON u.id = i.unit_id
    WHERE m.active = 1
      AND m.pid = ANY(${unique})
  `;

  const found = new Map<string, FolioContext>();
  for (const row of rows) {
    found.set(row.pid, {
      pid: row.pid,
      kind: 'maintenance' as LinkType,
      entityId: row.maintenance_id,
      ecoNumber: row.eco_number?.trim().toUpperCase() ?? null,
      openedAt: row.created_at,
    });
  }

  const missing = unique.filter((pid) => !found.has(pid));

  return { found, missing };
}

/**
 * Piezas mayores ya presentes en cada folio por documentos YA ligados.
 *
 * R6 necesita saber qué hay antes de decidir sobre un documento nuevo: dos
 * clutchs son anomalía aunque lleguen en documentos distintos.
 *
 * Se consulta contra los links vigentes en la app, no contra applied_links,
 * porque durante el modo auditoría los links los sigue escribiendo el cron
 * viejo y hay que mirar el estado real.
 */
export async function fetchFolioPartTallies(
  pids: string[],
  productCodesByGroup: Map<string, Set<string>>,
): Promise<Map<string, Record<string, number>>> {
  const result = new Map<string, Record<string, number>>();

  const unique = [...new Set(pids)];
  if (unique.length === 0 || productCodesByGroup.size === 0) return result;

  // Se traen todos los códigos de una vez y se agrupan en memoria: son pocos
  // (decenas por grupo) y evita una consulta por grupo.
  const allCodes = [...new Set([...productCodesByGroup.values()].flatMap((s) => [...s]))];
  if (allCodes.length === 0) return result;

  const rows = await appDb<
    { linked_pid: string; product_code: string; units: number }[]
  >`
    SELECT
      cdl.linked_pid                      AS linked_pid,
      UPPER(TRIM(p.product_code))         AS product_code,
      SUM(GREATEST(COALESCE(mv.units, 1), 1)) AS units
    FROM comercial_document_links cdl
    JOIN comercial_adm_movements mv
      ON mv.document_id = cdl.document_id AND mv.active = 1
    JOIN comercial_adm_products p
      ON p.product_id = mv.product_id AND p.active = 1
    WHERE cdl.active = 1
      AND cdl.linked_pid = ANY(${unique})
      AND UPPER(TRIM(p.product_code)) = ANY(${allCodes})
    GROUP BY cdl.linked_pid, UPPER(TRIM(p.product_code))
  `;

  for (const row of rows) {
    const tally = result.get(row.linked_pid) ?? {};

    for (const [groupCode, codes] of productCodesByGroup) {
      if (!codes.has(row.product_code)) continue;
      tally[groupCode] = (tally[groupCode] ?? 0) + Number(row.units);
    }

    result.set(row.linked_pid, tally);
  }

  return result;
}

/** Links vigentes de un conjunto de documentos, para no re-proponer lo ya hecho. */
export async function fetchExistingLinks(
  documentIds: number[],
): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>();
  if (documentIds.length === 0) return result;

  const rows = await appDb<{ document_id: number; linked_pid: string | null }[]>`
    SELECT document_id, linked_pid
    FROM comercial_document_links
    WHERE active = 1 AND document_id = ANY(${documentIds})
  `;

  for (const row of rows) {
    if (!row.linked_pid) continue;
    const set = result.get(row.document_id) ?? new Set<string>();
    set.add(row.linked_pid);
    result.set(row.document_id, set);
  }

  return result;
}
