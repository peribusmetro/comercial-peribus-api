import { appDb, validatorDb } from '@/db/clients';

/**
 * Aplicador de links.
 *
 * ESTE ES EL ÚNICO MÓDULO QUE ESCRIBE EN LA BASE DE LA APP.
 *
 * Escribe `comercial_document_links` en el Supabase de peribus-incidents-admin.
 * Esa tabla se queda ahí (y no en la DB del validador) porque tiene FK a
 * maintenances.id y más de veinte consultas de la app le hacen JOIN directo.
 *
 * Todo lo que se aplica se refleja también en `applied_links` de la DB propia,
 * para poder auditar y reconstruir sin depender de la otra base.
 */

export interface LinkToApply {
  documentId: number;
  folioPid: string;
  entityId: number;
  matchMethod?: string;
  confidence?: string;
}

export interface ApplyResult {
  attempted: number;
  applied: number;
  skipped: number;
  errors: string[];
}

const CHUNK = 200;

/**
 * Escribe los links en la app y los registra localmente.
 *
 * El INSERT respeta la regla de idempotencia que ya usa la app: el NOT EXISTS
 * mira TODAS las filas del par (documento, folio), activas o no. Una fila con
 * active=0 significa que alguien desvinculó a mano porque el folio del ERP
 * estaba mal; volver a ligarlo desharía esa corrección.
 */
export async function applyLinks(
  links: LinkToApply[],
  runId: number | null,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    attempted: links.length,
    applied: 0,
    skipped: 0,
    errors: [],
  };

  if (links.length === 0) return result;

  for (let i = 0; i < links.length; i += CHUNK) {
    const batch = links.slice(i, i + CHUNK);

    try {
      const rows = await appDb<{ document_id: number; linked_pid: string }[]>`
        INSERT INTO comercial_document_links
          (document_id, link_type, maintenance_id, linked_pid, match_method, confidence)
        SELECT
          v.document_id,
          'maintenance',
          v.maintenance_id,
          v.linked_pid,
          v.match_method,
          v.confidence
        FROM (
          VALUES ${appDb(
            batch.map((l) => [
              l.documentId,
              l.entityId,
              l.folioPid,
              l.matchMethod ?? 'validator_auto',
              l.confidence ?? 'high',
            ]),
          )}
        ) AS v(document_id, maintenance_id, linked_pid, match_method, confidence)
        WHERE NOT EXISTS (
          SELECT 1 FROM comercial_document_links existing
          WHERE existing.document_id = v.document_id
            AND existing.maintenance_id = v.maintenance_id
        )
        RETURNING document_id, linked_pid
      `;

      result.applied += rows.length;
      result.skipped += batch.length - rows.length;

      if (rows.length > 0) {
        const applied = rows.map((r) => {
          const source = batch.find(
            (l) => l.documentId === r.document_id && l.folioPid === r.linked_pid,
          );
          return {
            run_id: runId,
            document_id: r.document_id,
            folio_pid: r.linked_pid,
            link_type: 'maintenance',
            match_method: source?.matchMethod ?? 'validator_auto',
            confidence: source?.confidence ?? 'high',
          };
        });

        await validatorDb`
          INSERT INTO applied_links ${validatorDb(applied)}
          ON CONFLICT (document_id, folio_pid) DO UPDATE SET
            run_id       = EXCLUDED.run_id,
            match_method = EXCLUDED.match_method,
            confidence   = EXCLUDED.confidence,
            applied_at   = NOW(),
            revoked_at   = NULL,
            active       = 1
        `;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Lote ${i}-${i + batch.length}: ${message}`);
    }
  }

  return result;
}

/**
 * Revoca un link previamente aplicado.
 *
 * Se usa cuando un humano rechaza un par que el validador había ligado.
 * Desactiva en vez de borrar: la app usa índices únicos parciales
 * (WHERE active = 1) justamente para permitir re-vincular después.
 */
export async function revokeLink(documentId: number, folioPid: string): Promise<boolean> {
  const rows = await appDb<{ id: number }[]>`
    UPDATE comercial_document_links
    SET active = 0
    WHERE active = 1
      AND document_id = ${documentId}
      AND linked_pid = ${folioPid}
    RETURNING id
  `;

  if (rows.length > 0) {
    await validatorDb`
      UPDATE applied_links
      SET active = 0, revoked_at = NOW()
      WHERE document_id = ${documentId} AND folio_pid = ${folioPid}
    `;
  }

  return rows.length > 0;
}
