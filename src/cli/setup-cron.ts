import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';

/**
 * Monta el cron diario del validador en su propio Supabase.
 *
 *   npm run setup:cron -- https://tu-api.vercel.app
 *   npm run setup:cron -- https://tu-api.vercel.app --dry-run
 *
 * Hace lo que describe `supabase/cron.sql`, pero de forma ejecutable e
 * idempotente: extensiones, secretos en Vault, la función que dispara cada
 * paso y los cuatro jobs. Correrlo dos veces no duplica nada.
 *
 * La clave interna se lee del .env local y se guarda en Vault, nunca en texto
 * plano dentro de una definición de job: `cron.job.command` es legible por
 * cualquiera que pueda consultar esa tabla.
 *
 * No importa `@/config/env` a propósito: ese módulo arrastra los clientes de
 * Postgres de la app, y aquí solo hace falta la base del validador.
 */

loadDotenv();

interface Paso {
  /** Paso del ETL, tal como lo espera /internal/run?step=… */
  nombre: string;
  /** Nombre del job en cron.job; se mantiene igual al de supabase/cron.sql. */
  job: string;
  schedule: string;
  hora: string;
}

// El orden importa: los movimientos necesitan los documentos ya sincronizados,
// y la validación necesita ambos. Se separan 5 minutos para que cada paso
// termine antes de que arranque el siguiente.
const PASOS: Paso[] = [
  { nombre: 'documents', job: 'validador-1-documentos', schedule: '0 9 * * *', hora: '03:00 MX' },
  { nombre: 'movements', job: 'validador-2-movimientos', schedule: '5 9 * * *', hora: '03:05 MX' },
  { nombre: 'catalogs', job: 'validador-3-catalogos', schedule: '10 9 * * *', hora: '03:10 MX' },
  { nombre: 'validate', job: 'validador-4-validacion', schedule: '15 9 * * *', hora: '03:15 MX' },
];

function leerEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    console.error(`Falta ${nombre} en el .env local.`);
    process.exit(1);
  }
  return valor;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apiUrl = args.find((a) => a.startsWith('http'))?.replace(/\/$/, '');

  if (!apiUrl) {
    console.error('Uso: npm run setup:cron -- <url-de-la-api> [--dry-run]');
    process.exit(1);
  }

  const apiKey = leerEnv('INTERNAL_API_KEY');
  const dbUrl = leerEnv('VALIDATOR_DATABASE_URL');

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Cron del validador — instalación');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  API     : ${apiUrl}`);
  console.log(`  clave   : ${apiKey.slice(0, 4)}…${apiKey.slice(-2)} (${apiKey.length} caracteres)`);
  console.log(`  modo    : ${dryRun ? 'DRY-RUN (no escribe nada)' : 'aplicar cambios'}\n`);

  // `max: 1` y sin prepare: se ejecutan DDL y funciones administrativas, que
  // no se benefician del pool y prefieren una sola sesión predecible.
  const sql = postgres(dbUrl, { ssl: 'require', prepare: false, max: 1, idle_timeout: 20 });

  try {
    // --- 1. Extensiones -----------------------------------------------------
    // pg_cron y pg_net viven en el esquema `extensions` en Supabase.
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
    // Se actualizan si ya existen: así cambiar la URL del despliegue no obliga
    // a borrar y volver a agendar los jobs.
    const secretos: Array<[string, string]> = [
      ['validator_api_url', apiUrl],
      ['validator_api_key', apiKey],
    ];

    for (const [nombre, valor] of secretos) {
      const [existente] = await sql<{ id: string }[]>`
        SELECT id FROM vault.secrets WHERE name = ${nombre}`;

      if (dryRun) {
        console.log(`  · secreto ${nombre} ${existente ? 'SE ACTUALIZARÍA' : 'SE CREARÍA'}`);
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

    // --- 3. Función que dispara un paso ------------------------------------
    // Idéntica a la de supabase/cron.sql. Lee los secretos de Vault en cada
    // llamada, así que rotar la clave no exige recrear nada.
    if (dryRun) {
      console.log('  · función trigger_validator_step SE CREARÍA/ACTUALIZARÍA');
    } else {
      await sql.unsafe(`
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
      `);
      console.log('  ✓ función trigger_validator_step creada');

      // La función expone la clave interna a quien pueda ejecutarla, así que
      // solo la usa el cron (que corre como superusuario). Se le quita el
      // permiso a los roles que la API expone públicamente.
      await sql.unsafe(`
        REVOKE ALL ON FUNCTION public.trigger_validator_step(TEXT) FROM PUBLIC;
        REVOKE ALL ON FUNCTION public.trigger_validator_step(TEXT) FROM anon, authenticated;
      `);
      console.log('  ✓ permisos restringidos (anon/authenticated no pueden invocarla)');
    }

    // --- 4. Los cuatro jobs -------------------------------------------------
    // cron.schedule con un nombre existente reemplaza el job, no lo duplica.
    console.log('');
    for (const paso of PASOS) {
      const job = paso.job;
      const comando = `SELECT public.trigger_validator_step('${paso.nombre}')`;

      if (dryRun) {
        console.log(`  · ${job.padEnd(26)} ${paso.schedule.padEnd(11)} (${paso.hora}) SE AGENDARÍA`);
        continue;
      }
      await sql`SELECT cron.schedule(${job}, ${paso.schedule}, ${comando})`;
      console.log(`  ✓ ${job.padEnd(26)} ${paso.schedule.padEnd(11)} (${paso.hora})`);
    }

    // --- 5. Verificación ----------------------------------------------------
    if (dryRun) {
      console.log('\n  Dry-run: no se aplicó ningún cambio.\n');
      return;
    }

    console.log('\n───────────────────────────────────────────────────');
    console.log('  Verificación');
    console.log('───────────────────────────────────────────────────\n');

    const jobs = await sql<{ jobid: string; jobname: string; schedule: string; active: boolean }[]>`
      SELECT jobid, jobname, schedule, active
      FROM cron.job
      WHERE jobname LIKE 'validador-%'
      ORDER BY jobname`;

    for (const j of jobs) {
      console.log(`  [${j.jobid}] ${j.jobname.padEnd(26)} ${j.schedule.padEnd(11)} activo=${j.active}`);
    }

    const esperados = PASOS.length;
    if (jobs.length !== esperados) {
      console.error(`\n  ✗ Se esperaban ${esperados} jobs y hay ${jobs.length}.`);
      process.exitCode = 1;
      return;
    }

    const inactivos = jobs.filter((j) => !j.active);
    if (inactivos.length > 0) {
      console.error(`\n  ✗ Hay jobs inactivos: ${inactivos.map((j) => j.jobname).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n  ✓ ${jobs.length} jobs agendados y activos.`);
    console.log('\n  Próxima corrida: 03:00 MX (09:00 UTC).');
    console.log('  Seguimiento:  SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 10;\n');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('\nFALLO:', error instanceof Error ? error.message : error);
  process.exit(1);
});
