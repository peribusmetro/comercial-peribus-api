import { Router } from 'express';
import { z } from 'zod';
import { validatorDb } from '../../db/clients';
import {
  ChangeNotFoundError,
  ChangeNotPendingError,
  resolveSourceChange,
  type SourceChangeRow,
} from '../../services/publisher';
import { asyncHandler } from '../middleware';

/**
 * Cambios de origen: documentos que cambiaron, se cancelaron o se borraron en
 * AdminPAQ mientras tenían vínculos en la app. La app los muestra en la
 * columna ORIGEN y los resuelve desde aquí.
 *
 * Requieren API_KEYS (los consume la app Next por server action).
 */

export const changesRouter = Router();

const listQuery = z.object({
  documentIds: z.string().optional(),
  status: z.enum(['pending', 'synced', 'kept', 'obsolete']).default('pending'),
  type: z.enum(['modified', 'cancelled', 'deleted']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function publicShape(row: SourceChangeRow) {
  return {
    id: Number(row.id),
    document_id: row.document_id,
    change_type: row.change_type,
    status: row.status,
    detected_at: row.detected_at,
    updated_at: row.updated_at,
    entries: row.diff.length,
    /** Resumen corto para el badge/tooltip. */
    summary: summarize(row),
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
  };
}

function summarize(row: SourceChangeRow): string {
  if (row.change_type === 'deleted') return 'Documento eliminado en el ERP';
  if (row.change_type === 'cancelled') return 'Documento cancelado en el ERP';
  const labels = [...new Set(row.diff.map((d) => d.label))];
  const head = labels.slice(0, 3).join(', ');
  return labels.length > 3
    ? `Cambió: ${head} y ${labels.length - 3} más`
    : `Cambió: ${head}`;
}

// ---------------------------------------------------------------------------
// GET /changes/pending?documentIds=1,2,3   → mapa por documento (columna ORIGEN)
// GET /changes/pending?page=1&pageSize=50  → bandeja paginada
// ---------------------------------------------------------------------------

changesRouter.get(
  '/pending',
  asyncHandler(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Parámetros inválidos', detail: parsed.error.issues });
      return;
    }
    const q = parsed.data;

    if (q.documentIds !== undefined) {
      const ids = q.documentIds
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
      if (ids.length === 0) {
        res
          .status(400)
          .json({ error: 'documentIds debe traer al menos un id' });
        return;
      }
      if (ids.length > 500) {
        res.status(400).json({ error: 'Máximo 500 documentos por consulta' });
        return;
      }

      const rows = await validatorDb<SourceChangeRow[]>`
        SELECT * FROM source_changes
        WHERE status = 'pending' AND document_id = ANY(${ids})`;

      const changes: Record<number, ReturnType<typeof publicShape>> = {};
      for (const row of rows) changes[row.document_id] = publicShape(row);
      res.json({ changes });
      return;
    }

    const where = validatorDb`WHERE status = ${q.status} ${
      q.type ? validatorDb`AND change_type = ${q.type}` : validatorDb``
    }`;

    const [[count], rows] = await Promise.all([
      validatorDb<
        { total: string }[]
      >`SELECT COUNT(*)::text AS total FROM source_changes ${where}`,
      validatorDb<SourceChangeRow[]>`
        SELECT * FROM source_changes ${where}
        ORDER BY detected_at DESC
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
    ]);

    res.json({
      items: rows.map(publicShape),
      total: Number(count.total),
      page: q.page,
      pageSize: q.pageSize,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /changes/:id — detalle con el diff completo
// ---------------------------------------------------------------------------

const idParam = z.coerce.number().int().positive();

changesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'id inválido' });
      return;
    }
    const [row] = await validatorDb<SourceChangeRow[]>`
      SELECT * FROM source_changes WHERE id = ${id.data}`;
    if (!row) {
      res.status(404).json({ error: 'Cambio no encontrado' });
      return;
    }
    res.json({
      ...publicShape(row),
      diff: row.diff,
      resolution: row.resolution,
      resolved_note: row.resolved_note,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /changes/:id/sync  → la app recibe la versión del ERP
// POST /changes/:id/keep  → la app conserva su versión
// ---------------------------------------------------------------------------

const resolveBody = z.object({
  resolvedBy: z.string().min(1, 'resolvedBy es obligatorio'),
  note: z.string().max(1000).optional(),
});

for (const action of ['sync', 'keep'] as const) {
  changesRouter.post(
    `/:id/${action}`,
    asyncHandler(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'id inválido' });
        return;
      }
      const body = resolveBody.safeParse(req.body);
      if (!body.success) {
        res
          .status(400)
          .json({ error: 'Cuerpo inválido', detail: body.error.issues });
        return;
      }

      try {
        const result = await resolveSourceChange(
          id.data,
          action,
          body.data.resolvedBy,
          body.data.note,
        );
        res.json({
          ...publicShape(result.change),
          resolution: result.resolution,
        });
      } catch (err) {
        if (err instanceof ChangeNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ChangeNotPendingError) {
          res.status(409).json({ error: err.message, status: err.status });
          return;
        }
        throw err;
      }
    }),
  );
}
