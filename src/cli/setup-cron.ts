import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';

/**
 * Monta el cron diario del validador en su propio Supabase.
 *
 *   npm run setup:cron -- https://tu-api.vercel.app
 *   npm run setup:cron -- https://tu-api.vercel.app --dry-run
 *   npm run setup:cron -- https://tu-api.vercel.app --env .env.production
 *
 * Hace lo que describe `supabase/cron.sql`, pero de forma ejecutable e
 * idempotente: extensiones, secretos en Vault, las funciones que disparan
 * cada paso y mandan la alerta, y los jobs. Correrlo dos veces no duplica
 * nada; correrlo tras un cambio de URL o de clave solo actualiza Vault.
 *
 * Flujo nocturno (hora de México, UTC-6 sin horario de verano):
 *   01:30  ingest    AdminPAQ → staging (9 tablas)
 *   02:00  validate  reglas → anomalías
 *   02:15  publish   staging → app (con retención de lo vinculado)
 *   06:00  alerta    correo si algún paso falló o no corrió
 *   dom 04:00  limpieza de bitácoras de pg_cron / pg_net
 *
 * Los jobs anteriores (documents / movements / catalogs / validate a las
 * 03:00) se dan de baja: `ingest` los sustituye.
 *
 * La clave interna, la de Resend y los correos se leen del .env indicado y
 * se guardan en Vault, nunca en texto plano dentro de un job: `cron.job.command`
 * es legible por cualquiera que pueda consultar esa tabla.
 *
 * No importa `@/config/env` a propósito: ese módulo arrastra los clientes de
 * Postgres de la app, y aquí solo hace falta la base del validador.
 */

interface Job {
  name: string;
  schedule: string;
  hora: string;
  command: string;
  /** Si falta la configuración de alerta, el job no se agenda. */
  requiresAlert?: boolean;
}

const JOBS: Job[] = [
  {
    name: 'validador-1-ingesta',
    schedule: '30 7 * * *',
    hora: '01:30 MX',
    command: `SELECT public.trigger_validator_step('ingest')`,
  },
  {
    name: 'validador-2-validacion',
    schedule: '0 8 * * *',
    hora: '02:00 MX',
    command: `SELECT public.trigger_validator_step('validate')`,
  },
  {
    name: 'validador-3-publicacion',
    schedule: '15 8 * * *',
    hora: '02:15 MX',
    command: `SELECT public.trigger_validator_step('publish')`,
  },
  {
    name: 'validador-8-limpieza',
    schedule: '0 10 * * 0',
    hora: 'dom 04:00 MX',
    command: `SELECT public.cleanup_validator_logs()`,
  },
  {
    name: 'validador-9-alerta',
    schedule: '0 12 * * *',
    hora: '06:00 MX',
    command: `SELECT public.notify_validator_failures()`,
    requiresAlert: true,
  },
];

/** Jobs del esquema anterior, sustituidos por `ingest`. */
const LEGACY_JOBS = [
  'validador-1-documentos',
  'validador-2-movimientos',
  'validador-3-catalogos',
  'validador-4-validacion',
];

function leerEnv(nombre: string, obligatoria = true): string | undefined {
  const valor = process.env[nombre];
  if (!valor && obligatoria) {
    console.error(`Falta ${nombre} en el archivo de entorno.`);
    process.exit(1);
  }
  return valor;
}

const TRIGGER_FN = `
CREATE OR REPLACE FUNCTION public.trigger_validator_step(step_name TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, net
AS $fn$
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
    -- Timeout corto a propósito: el endpoint responde 202 enseguida y
    -- sigue trabajando en segundo plano.
    timeout_milliseconds := 8000
  ) INTO request_id;

  RETURN request_id;
END;
$fn$;
`;

/**
 * Alerta de las 06:00: revisa que ingest, validate y publish hayan terminado
 * con éxito HOY (hora de México). Si alguno falló o no corrió, manda un correo
 * por Resend. Si todo está bien no manda nada: solo avisa cuando hay problema.
 */
const ALERT_FN = `
CREATE OR REPLACE FUNCTION public.notify_validator_failures()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, net
AS $fn$
DECLARE
  resend_key   TEXT;
  emails       TEXT;
  from_addr    TEXT;
  api_url      TEXT;
  hoy          DATE := (NOW() AT TIME ZONE 'America/Mexico_City')::date;
  problemas    TEXT := '';
  pendientes   INTEGER := 0;
  ultimo       TEXT;
  paso         TEXT;
  request_id   BIGINT;
BEGIN
  SELECT decrypted_secret INTO resend_key FROM vault.decrypted_secrets WHERE name = 'validator_resend_key';
  SELECT decrypted_secret INTO emails     FROM vault.decrypted_secrets WHERE name = 'validator_alert_emails';
  SELECT decrypted_secret INTO from_addr  FROM vault.decrypted_secrets WHERE name = 'validator_alert_from';
  SELECT decrypted_secret INTO api_url    FROM vault.decrypted_secrets WHERE name = 'validator_api_url';

  IF resend_key IS NULL OR emails IS NULL THEN
    RAISE EXCEPTION 'Faltan los secretos validator_resend_key / validator_alert_emails en Vault';
  END IF;

  FOREACH paso IN ARRAY ARRAY['ingest', 'validate', 'publish'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE step = paso AND status = 'success'
        AND (started_at AT TIME ZONE 'America/Mexico_City')::date = hoy
    ) THEN
      SELECT status || COALESCE(' — ' || error_message, '') INTO ultimo
      FROM sync_runs
      WHERE step = paso AND (started_at AT TIME ZONE 'America/Mexico_City')::date = hoy
      ORDER BY started_at DESC LIMIT 1;

      problemas := problemas || '• ' || paso || ': ' || COALESCE(ultimo, 'no corrió hoy') || E'\\n';
    END IF;
  END LOOP;

  IF problemas = '' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO pendientes FROM source_changes WHERE status = 'pending';

  SELECT net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || resend_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',    COALESCE(from_addr, 'Peribus Metropolitano <admin@peribusmetro.mx>'),
      'to',      string_to_array(emails, ','),
      'subject', '[Validador comercial] Fallo en la corrida del ' || to_char(hoy, 'DD/MM/YYYY'),
      'text',    'Pasos con problema:' || E'\\n' || problemas
                 || E'\\nCambios de origen pendientes de decisión: ' || pendientes
                 || E'\\n\\nEstado: ' || COALESCE(api_url, '') || '/internal/status'
                 || E'\\nDetalle: SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10;'
    ),
    timeout_milliseconds := 8000
  ) INTO request_id;

  RETURN request_id;
END;
$fn$;
`;

/** Limpieza semanal de bitácoras: pg_cron y pg_net crecen sin tope. */
const CLEANUP_FN = `
CREATE OR REPLACE FUNCTION public.cleanup_validator_logs()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $fn$
DECLARE
  borrados_cron BIGINT;
  borrados_net  BIGINT;
BEGIN
  DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS borrados_cron = ROW_COUNT;
  DELETE FROM net._http_response WHERE created < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS borrados_net = ROW_COUNT;
  RETURN format('cron.job_run_details: %s · net._http_response: %s', borrados_cron, borrados_net);
END;
$fn$;
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apiUrl = args.find((a) => a.startsWith('http'))?.replace(/\/$/, '');
  const envIndex = args.indexOf('--env');
  const envFile = envIndex >= 0 ? args[envIndex + 1] : '.env';

  if (!apiUrl) {
    console.error(
      'Uso: npm run setup:cron -- <url-de-la-api> [--env .env.production] [--dry-run]',
    );
    process.exit(1);
  }

  loadDotenv({ path: envFile });

  const apiKey = leerEnv('INTERNAL_API_KEY')!;
  const dbUrl = leerEnv('VALIDATOR_DATABASE_URL')!;
  const resendKey = leerEnv('RESEND_API_KEY', false);
  const alertEmails = leerEnv('ALERT_EMAILS', false);
  const alertFrom = leerEnv('ALERT_FROM', false);
  const alertEnabled = Boolean(resendKey && alertEmails);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Cron del validador — instalación');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  entorno : ${envFile}`);
  console.log(`  API     : ${apiUrl}`);
  console.log(
    `  clave   : ${apiKey.slice(0, 4)}…${apiKey.slice(-2)} (${apiKey.length} caracteres)`,
  );
  console.log(
    `  alerta  : ${alertEnabled ? `sí → ${alertEmails}` : 'NO (faltan RESEND_API_KEY / ALERT_EMAILS)'}`,
  );
  console.log(
    `  modo    : ${dryRun ? 'DRY-RUN (no escribe nada)' : 'aplicar cambios'}\n`,
  );

  // `max: 1` y sin prepare: se ejecutan DDL y funciones administrativas, que
  // no se benefician del pool y prefieren una sola sesión predecible.
  const sql = postgres(dbUrl, {
    ssl: 'require',
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });

  try {
    // --- 1. Extensiones -----------------------------------------------------
    for (const ext of ['pg_cron', 'pg_net']) {
      const [ya] = await sql<{ instalada: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = ${ext}) AS instalada`;
      if (ya.instalada) {
        console.log(`  · ${ext} ya instalada`);
        continue;
      }
      if (dryRun) {
        console.log(`  · ${ext} SE INSTALARÍA`);
        continue;
      }
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      console.log(`  ✓ ${ext} instalada`);
    }

    // --- 2. Secretos en Vault ----------------------------------------------
    const secretos: Array<[string, string]> = [
      ['validator_api_url', apiUrl],
      ['validator_api_key', apiKey],
    ];
    if (alertEnabled) {
      secretos.push(['validator_resend_key', resendKey!]);
      secretos.push(['validator_alert_emails', alertEmails!]);
      if (alertFrom) secretos.push(['validator_alert_from', alertFrom]);
    }

    for (const [nombre, valor] of secretos) {
      const [existente] = await sql<{ id: string }[]>`
        SELECT id FROM vault.secrets WHERE name = ${nombre}`;
      if (dryRun) {
        console.log(
          `  · secreto ${nombre} ${existente ? 'SE ACTUALIZARÍA' : 'SE CREARÍA'}`,
        );
        continue;
      }
      if (existente) {
        await sql`SELECT vault.update_secret(${existente.id}::uuid, ${valor})`;
        console.log(`  ✓ secreto ${nombre} actualizado`);
      } else {
        await sql`SELECT vault.create_secret(${valor}, ${nombre})`;
        console.log(`  ✓ secreto ${nombre} creado`);
      }
    }

    // --- 3. Funciones ------------------------------------------------------
    const funciones: Array<[string, string]> = [
      ['trigger_validator_step', TRIGGER_FN],
      ['cleanup_validator_logs', CLEANUP_FN],
      ['notify_validator_failures', ALERT_FN],
    ];
    for (const [nombre, ddl] of funciones) {
      if (dryRun) {
        console.log(`  · función ${nombre} SE CREARÍA/ACTUALIZARÍA`);
        continue;
      }
      await sql.unsafe(ddl);
      // Las funciones exponen secretos o borran bitácoras: solo el cron (que
      // corre como superusuario) debe poder invocarlas.
      await sql.unsafe(`
        REVOKE ALL ON FUNCTION public.${nombre}(${nombre === 'trigger_validator_step' ? 'TEXT' : ''}) FROM PUBLIC;
        REVOKE ALL ON FUNCTION public.${nombre}(${nombre === 'trigger_validator_step' ? 'TEXT' : ''}) FROM anon, authenticated;
      `);
      console.log(
        `  ✓ función ${nombre} creada (anon/authenticated sin permiso)`,
      );
    }

    // --- 4. Baja de jobs anteriores ----------------------------------------
    console.log('');
    for (const legacy of LEGACY_JOBS) {
      const [existe] = await sql<{ jobid: string }[]>`
        SELECT jobid FROM cron.job WHERE jobname = ${legacy}`;
      if (!existe) continue;
      if (dryRun) {
        console.log(
          `  · ${legacy.padEnd(26)} SE DARÍA DE BAJA (sustituido por ingest)`,
        );
        continue;
      }
      await sql`SELECT cron.unschedule(${legacy})`;
      console.log(`  ✓ ${legacy.padEnd(26)} dado de baja`);
    }

    // --- 5. Jobs -------------------------------------------------------------
    for (const job of JOBS) {
      if (job.requiresAlert && !alertEnabled) {
        console.log(
          `  · ${job.name.padEnd(26)} omitido (sin configuración de alerta)`,
        );
        continue;
      }
      if (dryRun) {
        console.log(
          `  · ${job.name.padEnd(26)} ${job.schedule.padEnd(12)} (${job.hora}) SE AGENDARÍA`,
        );
        continue;
      }
      // cron.schedule con un nombre existente reemplaza el job, no lo duplica.
      await sql`SELECT cron.schedule(${job.name}, ${job.schedule}, ${job.command})`;
      console.log(
        `  ✓ ${job.name.padEnd(26)} ${job.schedule.padEnd(12)} (${job.hora})`,
      );
    }

    // --- 6. Verificación ----------------------------------------------------
    if (dryRun) {
      console.log('\n  Dry-run: no se aplicó ningún cambio.\n');
      return;
    }

    console.log('\n───────────────────────────────────────────────────');
    console.log('  Verificación');
    console.log('───────────────────────────────────────────────────\n');

    const jobs = await sql<
      { jobid: string; jobname: string; schedule: string; active: boolean }[]
    >`
      SELECT jobid, jobname, schedule, active
      FROM cron.job
      WHERE jobname LIKE 'validador-%'
      ORDER BY jobname`;

    for (const j of jobs) {
      console.log(
        `  [${j.jobid}] ${j.jobname.padEnd(26)} ${j.schedule.padEnd(12)} activo=${j.active}`,
      );
    }

    const esperados = JOBS.filter(
      (j) => !j.requiresAlert || alertEnabled,
    ).length;
    if (jobs.length !== esperados) {
      console.error(
        `\n  ✗ Se esperaban ${esperados} jobs y hay ${jobs.length}.`,
      );
      process.exitCode = 1;
      return;
    }
    const inactivos = jobs.filter((j) => !j.active);
    if (inactivos.length > 0) {
      console.error(
        `\n  ✗ Hay jobs inactivos: ${inactivos.map((j) => j.jobname).join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`\n  ✓ ${jobs.length} jobs agendados y activos.`);
    console.log(
      '\n  Próxima corrida: 01:30 MX (07:30 UTC) ingest → 02:00 validate → 02:15 publish.',
    );
    console.log(
      '  Seguimiento:  SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10;\n',
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('\nFALLO:', error instanceof Error ? error.message : error);
  process.exit(1);
});
