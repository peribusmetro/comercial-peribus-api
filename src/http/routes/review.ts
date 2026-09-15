import { Router } from 'express';
import { z } from 'zod';
import { validatorDb } from '@/db/clients';
import { computeFingerprint } from '@/domain/rules';
import type { StagedDocument } from '@/domain/types';
import { recordVerdict } from '@/services/verdicts';
import { revokeLink } from '@/services/link-applier';
import { asyncHandler } from '../middleware';

/**
 * Endpoints de revisión, consumidos por peribus-incidents-admin.
 *
 * Aquí es donde el ciclo se cierra: la app muestra las anomalías, alguien
 * decide, y esa decisión queda escrita para que el validador no vuelva a
 * marcar el mismo caso.
 */

export const reviewRouter = Router();

// ---------------------------------------------------------------------------
// GET /review/pending — bandeja de revisión
// ---------------------------------------------------------------------------

const pendingQuery = z.object({
  severity: z.enum(['high', 'medium', 'low']).optional(),
  rule: z.string().optional(),
  folio: z.string().optional(),
  outcome: z.enum(['quarantined', 'flagged']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

reviewRouter.get(
  '/pending',
  asyncHandler(async (req, res) => {
    const parsed = pendingQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Parámetros inválidos', detail: parsed.error.issues });
      return;
    }

    const { severity, rule, folio, outcome, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;

    const rows = await validatorDb<
      {
        id: string;
        document_id: number;
        folio_pid: string | null;
        rule_code: string;
        rule_name: string;
        severity: string;
        detail: string;
        evidence: Record<string, unknown>;
        outcome: string;
        detected_at: Date;
        business_name: string | null;
        document_series: string | null;
        folio: number | null;
        total: number | null;
        date: Date | null;
        extra_text_two: string | null;
        extra_text_three: string | null;
        total_count: string;
      }[]
    >`
      SELECT
        a.id, a.document_id, a.folio_pid, a.rule_code, r.name AS rule_name,
        a.severity, a.detail, a.evidence, a.outcome, a.detected_at,
        d.business_name, d.document_series, d.folio, d.total, d.date,
        d.extra_text_two, d.extra_text_three,
        COUNT(*) OVER() AS total_count
      FROM anomalies a
      JOIN validation_rules r ON r.code = a.rule_code
      LEFT JOIN adm_documents d ON d.document_id = a.document_id
      WHERE a.active = 1
        AND a.resolved_at IS NULL
        ${severity ? validatorDb`AND a.severity = ${severity}` : validatorDb``}
        ${rule ? validatorDb`AND a.rule_code = ${rule}` : validatorDb``}
        ${folio ? validatorDb`AND a.folio_pid = ${folio}` : validatorDb``}
        ${outcome ? validatorDb`AND a.outcome = ${outcome}` : validatorDb``}
      ORDER BY
        CASE a.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        a.detected_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    res.json({
      data: rows.map(({ total_count: _ignored, ...row }) => ({
        ...row,
        id: Number(row.id),
      })),
      page,
      pageSize,
      totalCount,
      pageCount: Math.ceil(totalCount / pageSize),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /review/folio/:pid — todo lo detectado en un folio
// ---------------------------------------------------------------------------

reviewRouter.get(
  '/folio/:pid',
  asyncHandler(async (req, res) => {
    const pid = req.params.pid;

    const [anomalies, verdicts] = await Promise.all([
      validatorDb`
        SELECT a.*, r.name AS rule_name
        FROM anomalies a
        JOIN validation_rules r ON r.code = a.rule_code
        WHERE a.active = 1 AND a.folio_pid = ${pid}
        ORDER BY a.detected_at DESC
      `,
      validatorDb`
        SELECT *
        FROM review_verdicts
        WHERE active = 1 AND folio_pid = ${pid}
        ORDER BY reviewed_at DESC
      `,
    ]);

    res.json({ folio_pid: pid, anomalies, verdicts });
  }),
);

// ---------------------------------------------------------------------------
// POST /review/verdict — registrar una decisión humana
// ---------------------------------------------------------------------------

const verdictBody = z.object({
  documentId: z.number().int().positive(),
  folioPid: z.string().min(1).nullable(),
  verdict: z.enum(['approved', 'rejected', 'corrected']),
  correctedToPid: z.string().min(1).nullable().optional(),
  scope: z.enum(['this_pair', 'document', 'rule_for_folio']).default('this_pair'),
  ruleCodes: z.array(z.string()).default([]),
  // Obligatoria a propósito: en seis meses alguien va a preguntar por qué
  // este gasto quedó en este folio, y la respuesta tiene que estar escrita.
  reason: z.string().min(3, 'La razón es obligatoria'),
  reviewedBy: z.string().min(1),
});

reviewRouter.post(
  '/verdict',
  asyncHandler(async (req, res) => {
    const parsed = verdictBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Cuerpo inválido', detail: parsed.error.issues });
      return;
    }

    const input = parsed.data;

    if (input.verdict === 'corrected' && !input.correctedToPid) {
      res.status(400).json({
        error: 'Un veredicto "corrected" requiere correctedToPid (el folio correcto)',
      });
      return;
    }

    // Se recalcula el fingerprint del estado ACTUAL del documento: el veredicto
    // queda atado a esa versión y caduca si el ERP la cambia.
    const docs = await validatorDb<
      (Omit<StagedDocument, 'movements' | 'concept_name'> & { concept_name: string | null })[]
    >`
      SELECT
        d.document_id, d.document_concept_id, c.concept_name, d.document_series,
        d.folio, d.date, d.business_name, d.rfc, d.nature, d.cancelled, d.total,
        d.extra_text_one, d.extra_text_two, d.extra_text_three, d.sql_timestamp_parsed
      FROM adm_documents d
      LEFT JOIN adm_concepts c ON c.concept_id = d.document_concept_id
      WHERE d.document_id = ${input.documentId}
    `;

    if (docs.length === 0) {
      res.status(404).json({ error: `El documento ${input.documentId} no está en staging` });
      return;
    }

    const movements = await validatorDb<StagedDocument['movements']>`
      SELECT
        mv.movement_id, mv.document_id, mv.product_id,
        p.product_code, p.product_name, mv.units, mv.price, mv.total, mv.extra_text_one
      FROM adm_movements mv
      LEFT JOIN adm_products p ON p.product_id = mv.product_id
      WHERE mv.active = 1 AND mv.document_id = ${input.documentId}
    `;

    const fingerprint = computeFingerprint({ ...docs[0], movements } as StagedDocument);

    const verdict = await recordVerdict({
      documentId: input.documentId,
      folioPid: input.folioPid,
      verdict: input.verdict,
      correctedToPid: input.correctedToPid ?? null,
      scope: input.scope,
      ruleCodes: input.ruleCodes as never[],
      reason: input.reason,
      reviewedBy: input.reviewedBy,
      sourceFingerprint: fingerprint,
    });

    // Un rechazo sobre un par ya ligado revoca el vínculo en la app.
    let linkRevoked = false;
    if (input.verdict === 'rejected' && input.folioPid) {
      linkRevoked = await revokeLink(input.documentId, input.folioPid);
    }

    res.status(201).json({ verdict, linkRevoked });
  }),
);

// ---------------------------------------------------------------------------
// GET /review/history/:documentId — historial de decisiones
// ---------------------------------------------------------------------------

reviewRouter.get(
  '/history/:documentId',
  asyncHandler(async (req, res) => {
    const documentId = Number(req.params.documentId);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      res.status(400).json({ error: 'documentId inválido' });
      return;
    }

    const [verdicts, anomalies] = await Promise.all([
      validatorDb`
        SELECT *
        FROM review_verdicts
        WHERE document_id = ${documentId}
        ORDER BY reviewed_at DESC
      `,
      validatorDb`
        SELECT a.*, r.name AS rule_name
        FROM anomalies a
        JOIN validation_rules r ON r.code = a.rule_code
        WHERE a.document_id = ${documentId}
        ORDER BY a.detected_at DESC
      `,
    ]);

    res.json({ document_id: documentId, verdicts, anomalies });
  }),
);
