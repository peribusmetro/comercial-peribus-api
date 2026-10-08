-- =============================================================================
-- 004_ingest_full_rows.sql
--
-- El validador pasa a ser el ÚNICO intermediario entre AdminPAQ y la app.
-- Para poder publicar en la app lo que la app necesita (unas 90 columnas en
-- documentos, 199 en conceptos) sin crear un esquema gigante aquí, cada fila
-- de staging guarda:
--
--   raw               la fila completa del ERP, con los nombres originales
--                     de AdminPAQ (CIDDOCUMENTO, CTEXTOEXTRA3, …)
--   source_hash       huella de `raw`; cambia si cambia cualquier columna
--   source_changed_at última vez que la huella cambió
--   deleted_at        el id ya no existe en el ERP (AdminPAQ borra físico)
--
-- Las columnas tipadas que ya existían (las que usan las reglas) se conservan
-- y se siguen llenando desde `raw`.
--
-- Se agregan las 5 tablas que faltaban para cubrir las 9 que lee la app.
-- Esas 5 no tienen columnas tipadas: ninguna regla las usa; solo se
-- publican.
-- =============================================================================

-- --- Columnas nuevas en las 4 tablas que ya existían ------------------------

ALTER TABLE adm_documents
  ADD COLUMN IF NOT EXISTS raw               JSONB,
  ADD COLUMN IF NOT EXISTS source_hash       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

ALTER TABLE adm_movements
  ADD COLUMN IF NOT EXISTS raw               JSONB,
  ADD COLUMN IF NOT EXISTS source_hash       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

ALTER TABLE adm_products
  ADD COLUMN IF NOT EXISTS raw               JSONB,
  ADD COLUMN IF NOT EXISTS source_hash       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

ALTER TABLE adm_concepts
  ADD COLUMN IF NOT EXISTS raw               JSONB,
  ADD COLUMN IF NOT EXISTS source_hash       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS source_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- La publicación busca "qué cambió desde la última vez"; el índice evita
-- recorrer 166k movimientos cada noche.
CREATE INDEX IF NOT EXISTS adm_documents_source_changed_idx ON adm_documents (source_changed_at);
CREATE INDEX IF NOT EXISTS adm_movements_source_changed_idx ON adm_movements (source_changed_at);

-- --- Tablas nuevas (solo raw, sin columnas tipadas) --------------------------

-- admExistenciaCosto → comercial_adm_stock_costs
CREATE TABLE IF NOT EXISTS adm_stock_costs (
  stock_id          INTEGER PRIMARY KEY,
  sql_timestamp     VARCHAR(40),
  raw               JSONB NOT NULL,
  source_hash       VARCHAR(40) NOT NULL,
  source_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active            INTEGER NOT NULL DEFAULT 1
);

-- admFoliosDigitales → comercial_adm_digital_stamps (sin CTIMESTAMP en el ERP)
CREATE TABLE IF NOT EXISTS adm_digital_stamps (
  digital_stamp_id  INTEGER PRIMARY KEY,
  raw               JSONB NOT NULL,
  source_hash       VARCHAR(40) NOT NULL,
  source_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active            INTEGER NOT NULL DEFAULT 1
);

-- admCostosHistoricos → comercial_adm_historical_costs
CREATE TABLE IF NOT EXISTS adm_historical_costs (
  historical_cost_id INTEGER PRIMARY KEY,
  sql_timestamp      VARCHAR(40),
  raw                JSONB NOT NULL,
  source_hash        VARCHAR(40) NOT NULL,
  source_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active             INTEGER NOT NULL DEFAULT 1
);

-- admAlmacenes → comercial_adm_warehouses (catálogo de ~11 filas)
CREATE TABLE IF NOT EXISTS adm_warehouses (
  warehouse_id      INTEGER PRIMARY KEY,
  sql_timestamp     VARCHAR(40),
  raw               JSONB NOT NULL,
  source_hash       VARCHAR(40) NOT NULL,
  source_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active            INTEGER NOT NULL DEFAULT 1
);

-- admPreciosCompra → comercial_adm_purchase_prices
CREATE TABLE IF NOT EXISTS adm_purchase_prices (
  purchase_price_id INTEGER PRIMARY KEY,
  sql_timestamp     VARCHAR(40),
  raw               JSONB NOT NULL,
  source_hash       VARCHAR(40) NOT NULL,
  source_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active            INTEGER NOT NULL DEFAULT 1
);

-- sync_runs.step admite ahora también 'ingest' (las 9 tablas en una corrida).
-- La columna es VARCHAR(40) sin CHECK, no hace falta alterarla.
