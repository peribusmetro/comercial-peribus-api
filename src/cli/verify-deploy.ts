import { config as loadDotenv } from 'dotenv';

/**
 * Verifica un despliegue recién publicado.
 *
 *   npm run verify:deploy https://tu-api.vercel.app
 *
 * Comprueba que responda, que la autenticación esté bien separada (que la
 * clave de lectura NO abra los endpoints internos) y que alcance sus bases.
 * No dispara sincronizaciones ni escribe nada.
 *
 * Lee el .env directo en vez de importar `@/config/env`: ese módulo arrastra
 * los clientes de Postgres, que abren conexiones y dejan el proceso colgado
 * al terminar. Aquí solo hacen falta dos claves.
 */

loadDotenv();

function readKeyFromEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name} en el .env local (se usa para autenticar las pruebas).`);
    process.exit(1);
  }
  return value;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function probe(
  url: string,
  options: { headers?: Record<string, string>; method?: string; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  // `timeoutMs` se extrae: no es opción válida de RequestInit.
  // Se usa AbortSignal.timeout en vez de un AbortController propio, que es
  // más simple y no deja temporizadores vivos entre llamadas.
  const { timeoutMs = 30_000, ...init } = options;

  // `Connection: close` evita que undici reutilice el socket entre pruebas:
  // con keep-alive, una conexión que el servidor da por cerrada deja la
  // siguiente petición esperando hasta agotar el timeout.
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Connection: 'close' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 4 KB: suficiente para leer el JSON de /anomalies/stats sin truncarlo a
  // media respuesta (truncarlo hacía fallar el parseo y reportar un falso error).
  return { status: res.status, body: (await res.text()).slice(0, 4096) };
}

async function main(): Promise<void> {
  const base = process.argv[2]?.replace(/\/$/, '');

  if (!base) {
    console.error('Uso: npm run verify:deploy <url>');
    console.error('Ej.: npm run verify:deploy https://comercial-peribus-api.vercel.app');
    process.exit(1);
  }

  const readKey = readKeyFromEnv('API_KEYS').split(',')[0].trim();
  const internalKey = readKeyFromEnv('INTERNAL_API_KEY');
  const checks: Check[] = [];

  console.log(`\nVerificando ${base}\n`);

  // 1. Health público
  try {
    const r = await probe(`${base}/health`);
    const parsed = r.status === 200 ? JSON.parse(r.body) : null;
    checks.push({
      name: 'GET /health (público)',
      ok: r.status === 200 && parsed?.status === 'ok',
      detail: r.status === 200 ? `modo: ${parsed?.mode}` : `HTTP ${r.status}`,
    });
  } catch (err) {
    checks.push({
      name: 'GET /health (público)',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Sin clave → 401
  const noKey = await probe(`${base}/review/pending`);
  checks.push({
    name: 'Sin API key → 401',
    ok: noKey.status === 401,
    detail: `HTTP ${noKey.status}`,
  });

  // 3. Clave inválida → 401
  const badKey = await probe(`${base}/review/pending`, {
    headers: { 'X-API-Key': 'clave-que-no-existe' },
  });
  checks.push({
    name: 'API key inválida → 401',
    ok: badKey.status === 401,
    detail: `HTTP ${badKey.status}`,
  });

  // 4. Clave de lectura válida → 200 (y prueba la DB del validador)
  const good = await probe(`${base}/review/pending?pageSize=1`, {
    headers: { 'X-API-Key': readKey },
    timeoutMs: 60_000,
  });
  checks.push({
    name: 'API key válida → 200',
    ok: good.status === 200,
    detail: good.status === 200 ? 'la DB del validador responde' : `HTTP ${good.status}: ${good.body}`,
  });

  // 5. La clave de LECTURA no debe abrir /internal
  const cross = await probe(`${base}/internal/status`, {
    headers: { 'X-API-Key': readKey },
  });
  checks.push({
    name: 'Clave de lectura NO abre /internal',
    ok: cross.status === 401,
    detail: cross.status === 401 ? 'correctamente rechazada' : `⚠️ HTTP ${cross.status}`,
  });

  // 6. La clave interna sí
  const internal = await probe(`${base}/internal/status`, {
    headers: { 'X-API-Key': internalKey },
    timeoutMs: 60_000,
  });
  checks.push({
    name: 'Clave interna → /internal/status',
    ok: internal.status === 200,
    detail: internal.status === 200 ? 'ok' : `HTTP ${internal.status}: ${internal.body}`,
  });

  // 7. Estadísticas (toca varias tablas del validador)
  const stats = await probe(`${base}/anomalies/stats`, {
    headers: { 'X-API-Key': readKey },
    timeoutMs: 60_000,
  });
  let statsDetail = `HTTP ${stats.status}`;
  if (stats.status === 200) {
    try {
      const parsed = JSON.parse(stats.body) as { totals?: { total_anomalies?: string } };
      statsDetail = `${parsed.totals?.total_anomalies ?? '?'} anomalías`;
    } catch {
      statsDetail = 'respuesta no parseable';
    }
  }
  checks.push({
    name: 'GET /anomalies/stats',
    ok: stats.status === 200,
    detail: statsDetail,
  });

  // --- Resultado ---
  console.log('─'.repeat(58));
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(34)} ${c.detail}`);
  }
  console.log('─'.repeat(58));

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log('\n✓ Despliegue verificado. La API está lista para la app Next.\n');
  } else {
    console.log(`\n✗ ${failed.length} verificación(es) fallaron.`);
    console.log('  Revisa las variables de entorno en el panel de Vercel.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error verificando el despliegue:", err instanceof Error ? err.message : err);
  process.exit(1);
});
