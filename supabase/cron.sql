-- =============================================================================
-- Cron diario del validador — se ejecuta en el proyecto Supabase DEL VALIDADOR
--
-- Requisitos (SQL Editor de Supabase, una sola vez):
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- Por qué está partido en cuatro pasos:
--   pg_net tiene un timeout corto y las funciones de Vercel también. Cada
--   paso responde 202 de inmediato y trabaja en segundo plano; el seguimiento
--   se hace por la tabla sync_runs, no por la respuesta HTTP.
--
-- Las horas son UTC. México (CST, UTC-6) sin horario de verano:
--   03:00 MX = 09:00 UTC
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Guardar la URL y la clave interna en Vault (NO en texto plano)
-- -----------------------------------------------------------------------------
-- Ejecutar una vez, sustituyendo los valores:
--
--   SELECT vault.create_secret('https://TU-API.vercel.app', 'validator_api_url');
--   SELECT vault.create_secret('TU_INTERNAL_API_KEY',       'validator_api_key');
--
-- Para actualizarlos después:
--   SELECT vault.update_secret(
--     (SELECT id FROM vault.secrets WHERE name = 'validator_api_url'),
--     'https://NUEVA-URL.vercel.app'
--   );


-- -----------------------------------------------------------------------------
-- 2. Función que dispara un paso del validador
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_validator_step(step_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  api_url     TEXT;
  api_key     TEXT;
  request_id  BIGINT;
BEGIN
  SELECT decrypted_secret INTO api_url
  FROM vault.decrypted_secrets WHERE name = 'validator_api_url';

  SELECT decrypted_secret INTO api_key
  FROM vault.decrypted_secrets WHERE name = 'validator_api_key';

  IF api_url IS NULL OR api_key IS NULL THEN
    RAISE EXCEPTION 'Faltan los secretos validator_api_url / validator_api_key en Vault';
  END IF;

  SELECT net.http_post(
    url     := api_url || '/internal/run?step=' || step_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-API-Key',    api_key
    ),
    body    := '{}'::jsonb,
    -- Timeout corto a propósito: el endpoint responde 202 enseguida.
    timeout_milliseconds := 8000
  ) INTO request_id;

  RETURN request_id;
END;
$$;


-- -----------------------------------------------------------------------------
-- 3. Agendar los cuatro pasos
-- -----------------------------------------------------------------------------
-- Se separan 5 minutos entre sí para que cada uno termine antes del siguiente.
-- El orden importa: los movimientos necesitan los documentos ya sincronizados,
-- y la validación necesita ambos.

SELECT cron.schedule(
  'validador-1-documentos',
  '0 9 * * *',                       -- 03:00 MX
  $$ SELECT public.trigger_validator_step('documents') $$
);

SELECT cron.schedule(
  'validador-2-movimientos',
  '5 9 * * *',                       -- 03:05 MX
  $$ SELECT public.trigger_validator_step('movements') $$
);

SELECT cron.schedule(
  'validador-3-catalogos',
  '10 9 * * *',                      -- 03:10 MX
  $$ SELECT public.trigger_validator_step('catalogs') $$
);

SELECT cron.schedule(
  'validador-4-validacion',
  '15 9 * * *',                      -- 03:15 MX
  $$ SELECT public.trigger_validator_step('validate') $$
);


-- -----------------------------------------------------------------------------
-- Operación
-- -----------------------------------------------------------------------------
-- Ver los jobs agendados:
--   SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
--
-- Ver las últimas ejecuciones del cron:
--   SELECT j.jobname, r.status, r.start_time, r.return_message
--   FROM cron.job_run_details r
--   JOIN cron.job j USING (jobid)
--   ORDER BY r.start_time DESC LIMIT 20;
--
-- Ver qué respondió la API (pg_net guarda las respuestas):
--   SELECT id, status_code, content, created
--   FROM net._http_response
--   ORDER BY created DESC LIMIT 20;
--
-- Ver el resultado real de cada corrida (la fuente de verdad):
--   SELECT step, status, started_at, finished_at,
--          rows_read, rows_written, anomalies_found, error_message
--   FROM sync_runs
--   ORDER BY started_at DESC LIMIT 20;
--
-- Disparar un paso a mano:
--   SELECT public.trigger_validator_step('documents');
--
-- Desagendar:
--   SELECT cron.unschedule('validador-1-documentos');
