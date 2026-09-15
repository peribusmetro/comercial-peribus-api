-- =============================================================================
-- 001_initial_schema.sql
-- Esquema inicial de la DB propia del validador comercial.
--
-- Esta base es PROPIEDAD DEL API. No la escribe nadie más.
-- Contiene tres capas:
--   1. STAGING  — copia cruda de AdminPAQ (adm_*)
--   2. CONTROL  — historial de corridas (sync_runs)
--   3. DECISIÓN — anomalías, cuarentena y veredictos humanos
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CAPA 1: STAGING — copia de AdminPAQ (SQL Server)
--
-- Los nombres de columna replican el mapeo ya establecido en
-- peribus-scripts/scripts/sync-incremental.mjs para no inventar una segunda
-- convención. document_id / movement_id son las claves de NEGOCIO de AdminPAQ
-- (CIDDOCUMENTO / CIDMOVIMIENTO), no seriales propios.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adm_documents (
  document_id          INTEGER PRIMARY KEY,
  document_concept_id  INTEGER,
  document_series      VARCHAR(20),
  folio                DOUBLE PRECISION,
  date                 TIMESTAMPTZ,
  client_supplier_id   INTEGER,
  business_name        VARCHAR(120),
  rfc                  VARCHAR(20),
  reference            VARCHAR(120),
  observations         TEXT,
  nature               INTEGER,
  cancelled            INTEGER DEFAULT 0,
  net_amount           DOUBLE PRECISION,
  tax_one              DOUBLE PRECISION,
  total                DOUBLE PRECISION,
  currency_id          INTEGER,
  exchange_rate        DOUBLE PRECISION,
  username             VARCHAR(120),

  -- Campos libres de AdminPAQ. Son el puente con el negocio:
  --   extra_text_one   → suele traer eco de unidad a nivel documento
  --   extra_text_two   → unidad capturada (clave para R1/R3)
  --   extra_text_three → folio del sistema (M-YYMMDD-N / S-YYMMDD-N)
  extra_text_one       VARCHAR(100),
  extra_text_two       VARCHAR(100),
  extra_text_three     VARCHAR(100),

  -- CTIMESTAMP de AdminPAQ. Llega como texto MM/DD/YYYY, se conserva crudo
  -- y además parseado para poder ordenar/comparar sin sorpresas.
  sql_timestamp        VARCHAR(40),
  sql_timestamp_parsed TIMESTAMPTZ,

  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active               INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS adm_documents_folio_text_idx
  ON adm_documents (extra_text_three) WHERE active = 1;
CREATE INDEX IF NOT EXISTS adm_documents_unit_text_idx
  ON adm_documents (extra_text_two) WHERE active = 1;
CREATE INDEX IF NOT EXISTS adm_documents_date_idx
  ON adm_documents (date);
CREATE INDEX IF NOT EXISTS adm_documents_concept_idx
  ON adm_documents (document_concept_id);


CREATE TABLE IF NOT EXISTS adm_movements (
  movement_id       INTEGER PRIMARY KEY,
  document_id       INTEGER NOT NULL,
  movement_number   INTEGER,
  product_id        INTEGER,
  warehouse_id      INTEGER,
  units             DOUBLE PRECISION,
  price             DOUBLE PRECISION,
  net_amount        DOUBLE PRECISION,
  total             DOUBLE PRECISION,
  reference         VARCHAR(120),
  observations      TEXT,
  date              TIMESTAMPTZ,

  -- En movimientos, extra_text_one trae el eco_number de la unidad.
  extra_text_one    VARCHAR(100),

  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active            INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS adm_movements_document_idx
  ON adm_movements (document_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS adm_movements_product_idx
  ON adm_movements (product_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS adm_movements_eco_idx
  ON adm_movements (extra_text_one) WHERE active = 1;


CREATE TABLE IF NOT EXISTS adm_products (
  product_id     INTEGER PRIMARY KEY,
  product_code   VARCHAR(60),
  product_name   VARCHAR(200),
  product_type   INTEGER,
  status         INTEGER,
  description    TEXT,
  sat_key        VARCHAR(40),
  price_one      DOUBLE PRECISION,
  base_unit_id   INTEGER,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS adm_products_code_idx ON adm_products (product_code);


CREATE TABLE IF NOT EXISTS adm_concepts (
  concept_id    INTEGER PRIMARY KEY,
  concept_code  VARCHAR(40),
  concept_name  VARCHAR(200),
  nature        INTEGER,
  folio_type    INTEGER,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active        INTEGER NOT NULL DEFAULT 1
);


-- -----------------------------------------------------------------------------
-- CAPA 2: CONTROL — historial de corridas
--
-- Cada paso del ETL y cada corrida de validación deja rastro aquí. Permite
-- saber si el cron de las 3am corrió, cuánto tardó y qué encontró.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_runs (
  id             BIGSERIAL PRIMARY KEY,
  step           VARCHAR(40) NOT NULL,   -- documents | movements | catalogs | validate
  status         VARCHAR(20) NOT NULL,   -- running | success | failed
  mode           VARCHAR(20),            -- audit | enforce
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  rows_read      INTEGER DEFAULT 0,
  rows_written   INTEGER DEFAULT 0,
  anomalies_found INTEGER DEFAULT 0,
  error_message  TEXT,
  summary        JSONB
);

CREATE INDEX IF NOT EXISTS sync_runs_step_started_idx
  ON sync_runs (step, started_at DESC);


-- -----------------------------------------------------------------------------
-- CAPA 3: DECISIÓN — anomalías, cuarentena y veredictos
-- -----------------------------------------------------------------------------

-- Catálogo de reglas. Vive en tabla (no hardcodeado) para poder activar,
-- desactivar o recalibrar severidades sin desplegar código.
CREATE TABLE IF NOT EXISTS validation_rules (
  code          VARCHAR(40) PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  severity      VARCHAR(10) NOT NULL,     -- high | medium | low
  action        VARCHAR(20) NOT NULL,     -- quarantine | flag
  notify_buying BOOLEAN NOT NULL DEFAULT FALSE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO validation_rules (code, name, description, severity, action, notify_buying) VALUES
  ('R1_UNIT_MISMATCH',
   'Unidad discordante',
   'La unidad capturada en el documento no coincide con la unidad del folio de mantenimiento.',
   'high', 'quarantine', TRUE),

  ('R2_STOCK_PURCHASE',
   'Compra a stock',
   'Compra de almacén para inventario, no gasto atribuible a un folio de unidad.',
   'high', 'quarantine', FALSE),

  ('R3_MULTI_UNIT',
   'Documento multi-unidad',
   'El documento declara varias unidades; no puede cargarse completo a un solo folio.',
   'high', 'quarantine', TRUE),

  ('R4_LATE_RELINK',
   'Re-ligado tardío',
   'El folio del documento se modificó en el ERP mucho después de su captura original.',
   'low', 'flag', FALSE),

  ('R5_AMBIGUOUS_FOLIO',
   'Folio ambiguo',
   'El folio viene sin prefijo M-/S-, por lo que admite más de una interpretación.',
   'low', 'flag', FALSE),

  ('R6_DUPLICATE_MAJOR_PART',
   'Pieza mayor duplicada',
   'El folio acumula más de una pieza mayor del mismo grupo (ej. dos clutchs).',
   'medium', 'quarantine', TRUE)
ON CONFLICT (code) DO NOTHING;


-- Grupos de pieza mayor: productos de los que se espera COMO MÁXIMO uno por
-- folio. La tornillería, consumibles y mano de obra NO van aquí.
CREATE TABLE IF NOT EXISTS major_part_groups (
  id            SERIAL PRIMARY KEY,
  group_code    VARCHAR(40) NOT NULL UNIQUE,
  group_name    VARCHAR(200) NOT NULL,
  max_per_folio INTEGER NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS major_part_members (
  id            SERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES major_part_groups(id) ON DELETE CASCADE,
  product_code  VARCHAR(60) NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, product_code)
);

CREATE INDEX IF NOT EXISTS major_part_members_code_idx
  ON major_part_members (product_code);


-- Anomalías detectadas. Una fila por (documento, folio, regla).
CREATE TABLE IF NOT EXISTS anomalies (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT REFERENCES sync_runs(id),
  document_id    INTEGER NOT NULL,
  folio_pid      VARCHAR(40),
  rule_code      VARCHAR(40) NOT NULL REFERENCES validation_rules(code),
  severity       VARCHAR(10) NOT NULL,
  detail         TEXT NOT NULL,          -- legible por humanos
  evidence       JSONB,                  -- datos crudos que dispararon la regla

  -- 'quarantined' = no se ligó.  'flagged' = sí se ligó, marcado.
  outcome        VARCHAR(20) NOT NULL,

  -- Huella de los campos del ERP que importan. Si el documento cambia en
  -- AdminPAQ, la huella cambia y la anomalía se re-evalúa.
  source_fingerprint VARCHAR(64) NOT NULL,

  detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  active         INTEGER NOT NULL DEFAULT 1,

  UNIQUE (document_id, folio_pid, rule_code, source_fingerprint)
);

CREATE INDEX IF NOT EXISTS anomalies_pending_idx
  ON anomalies (severity, detected_at DESC) WHERE active = 1 AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS anomalies_document_idx
  ON anomalies (document_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS anomalies_folio_idx
  ON anomalies (folio_pid) WHERE active = 1;


-- Veredictos humanos. Esta tabla es la memoria del sistema: lo que un humano
-- ya decidió no se vuelve a preguntar (mientras el documento no cambie).
CREATE TABLE IF NOT EXISTS review_verdicts (
  id             BIGSERIAL PRIMARY KEY,
  document_id    INTEGER NOT NULL,
  folio_pid      VARCHAR(40),

  -- approved  → va, aunque la regla se haya quejado
  -- rejected  → no va; no se vuelve a proponer
  -- corrected → va, pero a otro folio (corrected_to_pid)
  verdict        VARCHAR(20) NOT NULL,
  corrected_to_pid VARCHAR(40),

  -- this_pair      → solo este documento con este folio
  -- document       → este documento contra cualquier folio
  -- rule_for_folio → perdona una regla en todo el folio
  scope          VARCHAR(20) NOT NULL DEFAULT 'this_pair',
  rule_codes     TEXT[] NOT NULL DEFAULT '{}',

  reason         TEXT NOT NULL,
  reviewed_by    VARCHAR(120) NOT NULL,
  reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Huella del documento al momento de decidir. Si el ERP cambia, el veredicto
  -- caduca automáticamente y el caso vuelve a revisión.
  source_fingerprint VARCHAR(64) NOT NULL,

  active         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS review_verdicts_lookup_idx
  ON review_verdicts (document_id, folio_pid) WHERE active = 1;
CREATE INDEX IF NOT EXISTS review_verdicts_folio_idx
  ON review_verdicts (folio_pid) WHERE active = 1;


-- Links que el API decidió escribir. Espejo local de lo que se envía a
-- Supabase (comercial_document_links), para poder reconstruir y auditar
-- sin depender de la otra base.
CREATE TABLE IF NOT EXISTS applied_links (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT REFERENCES sync_runs(id),
  document_id    INTEGER NOT NULL,
  folio_pid      VARCHAR(40) NOT NULL,
  link_type      VARCHAR(20) NOT NULL,     -- maintenance | accident
  match_method   VARCHAR(30) NOT NULL,     -- auto_exact | auto_normalized | manual_verdict
  confidence     VARCHAR(10) NOT NULL DEFAULT 'high',
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ,
  active         INTEGER NOT NULL DEFAULT 1,

  UNIQUE (document_id, folio_pid)
);

CREATE INDEX IF NOT EXISTS applied_links_folio_idx
  ON applied_links (folio_pid) WHERE active = 1;
