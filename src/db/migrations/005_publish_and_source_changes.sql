-- =============================================================================
-- 005_publish_and_source_changes.sql
--
-- Publicación staging → app con respeto a lo que la app ya decidió.
--
-- published_rows   memoria de "qué versión de cada fila tiene la app".
--                  Sin ella no hay forma de saber si lo que la app muestra es
--                  lo último del ERP. `published_hash` NULL significa que la
--                  app ya tenía la fila antes de que existiera este registro
--                  (bootstrap) y no se conoce su versión exacta.
--                  `held_hash` guarda la versión del ERP que se RETUVO porque
--                  el documento tiene vínculos en la app y cambió en origen.
--
-- source_changes   lo que la app muestra como "Modificado / Cancelado /
--                  Eliminado en origen". Una fila pendiente por documento; el
--                  diff es campo a campo con etiquetas en español para que la
--                  app lo pinte sin saber de AdminPAQ. Las líneas de
--                  movimientos del documento se incluyen en el mismo diff.
-- =============================================================================

CREATE TABLE IF NOT EXISTS published_rows (
  table_name        VARCHAR(60)  NOT NULL,   -- nombre ERP (admDocumentos, …)
  row_id            BIGINT       NOT NULL,
  published_hash    VARCHAR(40),             -- NULL = versión previa desconocida (bootstrap)
  published_deleted BOOLEAN      NOT NULL DEFAULT FALSE,
  published_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  held_hash         VARCHAR(40),
  held_since        TIMESTAMPTZ,
  PRIMARY KEY (table_name, row_id)
);

CREATE INDEX IF NOT EXISTS published_rows_held_idx
  ON published_rows (table_name, row_id) WHERE held_hash IS NOT NULL;


CREATE TABLE IF NOT EXISTS source_changes (
  id             BIGSERIAL PRIMARY KEY,
  document_id    INTEGER      NOT NULL,
  change_type    VARCHAR(20)  NOT NULL CHECK (change_type IN ('modified', 'cancelled', 'deleted')),
  -- [{ column, label, before, after, movement_id? }]
  diff           JSONB        NOT NULL,
  -- huella del documento en staging cuando se detectó (para saber si el ERP
  -- volvió a cambiar después)
  source_hash    VARCHAR(40),
  run_id         BIGINT,
  detected_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- pending  → esperando decisión en la app
  -- synced   → se publicó la versión del ERP (y se desactivaron vínculos si aplica)
  -- kept     → la app conservó su versión
  -- obsolete → el ERP volvió al estado publicado antes de que alguien decidiera
  status         VARCHAR(20)  NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'synced', 'kept', 'obsolete')),
  resolved_at    TIMESTAMPTZ,
  resolved_by    VARCHAR(120),
  resolved_note  TEXT,
  -- qué se desactivó al sincronizar una cancelación/borrado
  resolution     JSONB
);

-- Una sola pendiente por documento: si el origen vuelve a cambiar antes de
-- resolver, se actualiza el diff en vez de abrir otra.
CREATE UNIQUE INDEX IF NOT EXISTS source_changes_pending_idx
  ON source_changes (document_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS source_changes_document_idx
  ON source_changes (document_id);

CREATE INDEX IF NOT EXISTS source_changes_status_idx
  ON source_changes (status, detected_at DESC);

-- sync_runs.step admite ahora también 'publish'.
