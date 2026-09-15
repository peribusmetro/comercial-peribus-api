-- =============================================================================
-- 003_anomaly_null_folio_guard.sql
--
-- Cierra un hueco en la deduplicación de anomalías.
--
-- El UNIQUE de anomalies incluye folio_pid, que es nullable. En Postgres, NULL
-- nunca colisiona en un índice único, así que una anomalía con folio_pid NULL
-- esquivaría el ON CONFLICT DO NOTHING y se duplicaría en cada corrida diaria.
--
-- Hoy no se alcanza (todas las anomalías se generan dentro del bucle de folios,
-- con un pid concreto), pero el tipo DetectedAnomaly.folioPid permite null, así
-- que es cuestión de tiempo. Se cierra ahora que la tabla está vacía.
-- =============================================================================

-- Se sustituye la restricción por dos índices únicos parciales que sí cubren
-- el caso NULL.
ALTER TABLE anomalies
  DROP CONSTRAINT IF EXISTS anomalies_document_id_folio_pid_rule_code_source_fingerpri_key;

CREATE UNIQUE INDEX IF NOT EXISTS anomalies_dedup_with_folio_idx
  ON anomalies (document_id, folio_pid, rule_code, source_fingerprint)
  WHERE folio_pid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS anomalies_dedup_without_folio_idx
  ON anomalies (document_id, rule_code, source_fingerprint)
  WHERE folio_pid IS NULL;
