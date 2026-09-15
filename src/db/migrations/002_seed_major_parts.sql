-- =============================================================================
-- 002_seed_major_parts.sql
-- Semilla de grupos de pieza mayor para la regla R6.
--
-- Un grupo agrupa los códigos que representan LA MISMA pieza mayor, aunque el
-- ERP los tenga con nombres y precios distintos. Si un folio acumula más de
-- `max_per_folio` unidades del grupo, se retiene para revisión.
--
-- Criterio de inclusión: la pieza es UNA por unidad en una reparación normal.
-- Quedan FUERA a propósito:
--   · tornillería y consumibles (van varios y está bien)
--   · mano de obra y servicios (product_type = 3)
--   · piezas con nombre parecido pero distinta función (FANCLUTCH es el
--     ventilador del motor, no tiene relación con el embrague)
--
-- Los códigos salen del catálogo real de AdminPAQ (adm_products). Esta lista
-- es un punto de partida: se ajusta desde la app sin desplegar código.
-- =============================================================================

INSERT INTO major_part_groups (group_code, group_name, max_per_folio) VALUES
  ('CLUTCH',       'Clutch / embrague',            1),
  ('VOLANTE',      'Volante del motor',            1),
  ('COLLARIN',     'Collarín de clutch',           1),
  ('COMPRESOR',    'Compresor de aire',            1),
  ('GOBERNADOR',   'Gobernador de aire',           1),
  ('SECADOR',      'Secador de aire',              1),
  ('MARCHA',       'Marcha / arrancador',          1),
  ('ALTERNADOR',   'Alternador',                   1),
  ('RADIADOR',     'Radiador',                     1),
  ('TURBO',        'Turbocargador',                1)
ON CONFLICT (group_code) DO NOTHING;


-- --- CLUTCH ----------------------------------------------------------------
-- El caso que originó la regla: el folio M-260723-67 acumuló CLUTCH 904
-- CON COLLARIN LUK ($8,000), CLUTCH 904 ($8,500) y KIT DE CLUTCH AUT. x2
-- ($14,848). Tres códigos distintos, ningún duplicado exacto, y por eso el
-- detector anterior reportaba 0 duplicados.
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-0037', 'CLUTCH 904'),
  ('MTO-0038', 'CLUTCH 906'),
  ('MTO-1177', 'CLUTCH 904 CHICO TSP'),
  ('MTO-1319', 'CLUTCH 904 CON COLLARIN LUK'),
  ('MTO-0947', 'KIT DE CLUTCH AUT.'),
  -- Las reparaciones cuentan dentro del grupo: si se reparó el clutch, no se
  -- compró uno nuevo. Que aparezcan ambos también es anomalía.
  ('MTO-0275', 'REPARACION DE CLUTCH 904'),
  ('MTO-0276', 'REPARACION DE CLUTCH 906')
) AS v(code, note)
WHERE g.group_code = 'CLUTCH'
ON CONFLICT (group_id, product_code) DO NOTHING;


-- --- VOLANTE ---------------------------------------------------------------
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-0140', 'VOLANTE NUEVO 904'),
  ('MTO-0142', 'VOLANTE RECTIFICADO 904')
) AS v(code, note)
WHERE g.group_code = 'VOLANTE'
ON CONFLICT (group_id, product_code) DO NOTHING;


-- --- COLLARIN --------------------------------------------------------------
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-0042', 'COLLARIN 904')
) AS v(code, note)
WHERE g.group_code = 'COLLARIN'
ON CONFLICT (group_id, product_code) DO NOTHING;


-- --- COMPRESOR -------------------------------------------------------------
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-0205', 'CABEZA DE COMPRESOR MB')
) AS v(code, note)
WHERE g.group_code = 'COMPRESOR'
ON CONFLICT (group_id, product_code) DO NOTHING;


-- --- GOBERNADOR ------------------------------------------------------------
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-0233', 'GOBERNADOR TIPO WABCO')
) AS v(code, note)
WHERE g.group_code = 'GOBERNADOR'
ON CONFLICT (group_id, product_code) DO NOTHING;


-- --- SECADOR ---------------------------------------------------------------
INSERT INTO major_part_members (group_id, product_code, note)
SELECT g.id, v.code, v.note
FROM major_part_groups g
CROSS JOIN (VALUES
  ('MTO-1906', 'SECADOR DE AIRE TORINO')
) AS v(code, note)
WHERE g.group_code = 'SECADOR'
ON CONFLICT (group_id, product_code) DO NOTHING;
