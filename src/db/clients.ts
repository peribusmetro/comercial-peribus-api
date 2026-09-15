import postgres from 'postgres';
import { env } from '@/config/env';

/**
 * Dos conexiones distintas, a propósito:
 *
 *   validatorDb → DB propia del API (staging, anomalías, veredictos).
 *                 Lectura y escritura libre.
 *
 *   appDb       → Supabase de peribus-incidents-admin.
 *                 SOLO se escribe comercial_document_links, y solo desde
 *                 el aplicador. Todo lo demás es lectura.
 *
 * En Vercel cada invocación puede levantar un proceso nuevo, así que los
 * pools se cachean en globalThis para no abrir una conexión por request y
 * agotar el pooler de Supabase.
 */

type PgClient = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __validatorDb: PgClient | undefined;
  // eslint-disable-next-line no-var
  var __appDb: PgClient | undefined;
}

function createClient(url: string, label: string): PgClient {
  // Supabase exige TLS; un Postgres local de desarrollo o pruebas no lo tiene.
  // Se detecta por la URL en vez de exigir configuración extra.
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('sslmode=disable');

  return postgres(url, {
    ssl: isLocal ? false : 'require',
    // Obligatorio con el pooler de Supabase en modo transacción:
    // los prepared statements no sobreviven entre conexiones del pool.
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {
      /* silenciamos los NOTICE de Postgres, son ruido en logs */
    },
    connection: {
      application_name: `comercial-validator:${label}`,
    },
  });
}

export const validatorDb: PgClient =
  globalThis.__validatorDb ?? createClient(env.VALIDATOR_DATABASE_URL, 'validator');

export const appDb: PgClient =
  globalThis.__appDb ?? createClient(env.APP_DATABASE_URL, 'app');

if (env.NODE_ENV !== 'production') {
  globalThis.__validatorDb = validatorDb;
  globalThis.__appDb = appDb;
}

/** Cierra ambos pools. Solo para CLI/tests; en Vercel no se llama. */
export async function closeConnections(): Promise<void> {
  await Promise.allSettled([validatorDb.end(), appDb.end()]);
}
