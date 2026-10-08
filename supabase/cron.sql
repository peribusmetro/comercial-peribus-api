-- =============================================================================
-- Cron diario del validador — se ejecuta en el proyecto Supabase DEL VALIDADOR
--
-- Este archivo DOCUMENTA lo que instala `npm run setup:cron` (src/cli/setup-cron.ts),
-- que es la forma oficial de agendarlo (idempotente, secretos en Vault). Si se
-- cambia algo aquí, hay que cambiarlo allá, y viceversa.
--
-- Requisitos (una sola vez):
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- Flujo nocturno. Las horas son UTC; México (UTC-6, sin horario de verano):
--   01:30 MX = 07:30 UTC  ingest    AdminPAQ → staging (9 tablas)
--   02:00 MX = 08:00 UTC  validate  reglas → anomalías
--   02:15 MX = 08:15 UTC  publish   staging → app, con retención de lo vinculado
--   06:00 MX = 12:00 UTC  alerta    correo por Resend si un paso falló o no corrió
--   dom 04:00 MX          limpieza  bitácoras de pg_cron / pg_net
--
-- Cada paso responde 202 de inmediato y trabaja en segundo plano; el
-- seguimiento se hace por la tabla sync_runs, no por la respuesta HTTP.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Secretos en Vault (NO en texto plano)
-- -----------------------------------------------------------------------------
--   SELECT vault.create_secret('https://TU-API.vercel.app', 'validator_api_url');
--   SELECT vault.create_secret('TU_INTERNAL_API_KEY',       'validator_api_key');
--   SELECT vault.create_secret('re_xxx',                    'validator_resend_key');
--   SELECT vault.create_secret('a@x.com,b@x.com',           'validator_alert_emails');
--   SELECT vault.create_secret('Peribus <admin@peribusmetro.mx>', 'validator_alert_from');  -- opcional
--
-- Para actualizar uno:
--   SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'validator_api_url'), 'https://NUEVA');


-- -----------------------------------------------------------------------------
-- 2. Función que dispara un paso del validador
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_validator_step(step_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, net
AS $$
DECLARE
  api_url     TEXT;
  api_key     TEXT;
  request_id  BIGINT;
BEGIN
  SELECT decrypted_secret INTO api_url FROM vault.decrypted_secrets WHERE name = 'validator_api_url';
  SELECT decrypted_secret INTO api_key FROM vault.decrypted_secrets WHERE name = 'validator_api_key';

  IF api_url IS NULL OR api_key IS NULL THEN
    RAISE EXCEPTION 'Faltan los secretos validator_api_url / validator_api_key en Vault';
  END IF;

  SELECT net.http_post(
    url     := api_url || '/internal/run?step=' || step_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-API-Key', api_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 8000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_validator_step(TEXT) FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Alerta: solo manda correo cuando algo falló o no corrió hoy
-- -----------------------------------------------------------------------------
-- La definición completa está en setup-cron.ts (ALERT_FN). Resumen:
--   · revisa que ingest / validate / publish tengan una corrida 'success' HOY
--     (hora de México) en sync_runs
--   · si no, arma el texto con el último estado de cada paso y el número de
--     source_changes pendientes, y hace POST a https://api.resend.com/emails
--   · si todo está bien, devuelve NULL sin enviar nada
--
--   SELECT public.notify_validator_failures();


-- -----------------------------------------------------------------------------
-- 4. Limpieza semanal de bitácoras
-- -----------------------------------------------------------------------------
--   DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '30 days';
--   DELETE FROM net._http_response   WHERE created  < NOW() - INTERVAL '7 days';
--
--   SELECT public.cleanup_validator_logs();


-- -----------------------------------------------------------------------------
-- 5. Jobs
-- -----------------------------------------------------------------------------
SELECT cron.schedule('validador-1-ingesta',     '30 7 * * *',  $$ SELECT public.trigger_validator_step('ingest') $$);
SELECT cron.schedule('validador-2-validacion',  '0 8 * * *',   $$ SELECT public.trigger_validator_step('validate') $$);
SELECT cron.schedule('validador-3-publicacion', '15 8 * * *',  $$ SELECT public.trigger_validator_step('publish') $$);
SELECT cron.schedule('validador-8-limpieza',    '0 10 * * 0',  $$ SELECT public.cleanup_validator_logs() $$);
SELECT cron.schedule('validador-9-alerta',      '0 12 * * *',  $$ SELECT public.notify_validator_failures() $$);

-- Jobs del esquema anterior (03:00 MX, cuatro pasos). `ingest` los sustituye:
--   SELECT cron.unschedule('validador-1-documentos');
--   SELECT cron.unschedule('validador-2-movimientos');
--   SELECT cron.unschedule('validador-3-catalogos');
--   SELECT cron.unschedule('validador-4-validacion');

-- El paso de validación evalúa como máximo 5,000 documentos por corrida (los
-- más recientes por fecha; `loadStagedDocuments` en src/services/validator.ts).
-- Para el día a día alcanza; una auditoría del histórico se corre aparte por
-- CLI con un límite mayor.


-- -----------------------------------------------------------------------------
-- Operación
-- -----------------------------------------------------------------------------
-- Jobs agendados:
--   SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
--
-- Últimas ejecuciones del cron:
--   SELECT j.jobname, r.status, r.start_time, r.return_message
--   FROM cron.job_run_details r JOIN cron.job j USING (jobid)
--   ORDER BY r.start_time DESC LIMIT 20;
--
-- Qué respondió la API (pg_net guarda las respuestas):
--   SELECT id, status_code, content, created FROM net._http_response ORDER BY created DESC LIMIT 20;
--
-- Resultado real de cada corrida (la fuente de verdad):
--   SELECT step, status, started_at, finished_at, rows_read, rows_written, anomalies_found, error_message
--   FROM sync_runs ORDER BY started_at DESC LIMIT 20;
--
-- Cambios de origen pendientes de decisión en la app:
--   SELECT id, document_id, change_type, detected_at FROM source_changes WHERE status = 'pending';
--
-- Disparar un paso a mano:
--   SELECT public.trigger_validator_step('ingest');
