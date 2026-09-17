import postgres from 'postgres';
import { env } from '../config/env';

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
    // Un endpoint puede lanzar varias consultas en paralelo (p. ej.
    // /anomalies/stats hace 4). Con un pool más chico que esa cifra, las
    // sobrantes esperan una conexión libre y la petición se cuelga.
    max: 8,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {
      /* silenciamos los NOTICE de Postgres, son ruido en logs */
    },
    connection: {
      application_name: `comercial-validator:${label}`,
    },
    // Nota sobre el límite por consulta:
    //
    // Antes había aquí un `timeout: 45` con la intención de cortar consultas
    // atoradas. No hacía eso: en `postgres` esa opción es un alias deprecado
    // de `idle_timeout`, así que lo único que lograba era pisar el
    // `idle_timeout: 20` de arriba y dejar las conexiones ociosas 45s.
    //
    // No se sustituyó por `statement_timeout` porque el pooler de Supabase en
    // modo transacción lo ignora: se probaron las tres vías (la opción
    // `connection`, `options=-c` en la URL y el default) y las tres siguen
    // reportando los 2min del servidor. El límite real hoy lo pone el servidor,
    // no este cliente; si hace falta bajarlo, se cambia del lado de Supabase.
  });
}

/**
 * Los pools se crean al primer uso, no al importar el módulo.
 *
 * Importar `clients` ya no abre conexiones ni exige que el entorno sea válido:
 * eso permite que rutas que no tocan la base —`/health`— sigan respondiendo
 * aunque la configuración esté mal, en vez de tumbar la función completa.
 *
 * Se cachea SIEMPRE en globalThis, incluido producción. El idiom de Next
 * (`if (NODE_ENV !== 'production')`) existe para que el HMR de desarrollo no
 * acumule clientes; aquí el problema es el contrario. En Vercel el módulo se
 * evalúa una vez por cold start, y el globalThis es lo que permite reutilizar
 * el pool entre invocaciones de la misma instancia tibia. Sin esto se crean
 * pools huérfanos que nadie cierra y que agotan el pooler de Supabase.
 */
function getValidatorDb(): PgClient {
  globalThis.__validatorDb ??= createClient(env.VALIDATOR_DATABASE_URL, 'validator');
  return globalThis.__validatorDb;
}

function getAppDb(): PgClient {
  globalThis.__appDb ??= createClient(env.APP_DATABASE_URL, 'app');
  return globalThis.__appDb;
}

// Se exponen como proxies para no tocar los llamados existentes: el cliente de
// `postgres` se usa como función etiquetada (validatorDb de backtick) y también
// por métodos (.begin, .unsafe, .end). El proxy cubre ambas formas y abre la
// conexión en el primer acceso real, no al importar el módulo.
function lazyClient(resolve: () => PgClient): PgClient {
  return new Proxy(function () {} as unknown as PgClient, {
    apply: (_target, _thisArg, args) => {
      const client = resolve() as unknown as (...a: unknown[]) => unknown;
      return client(...args);
    },
    get: (_target, prop) => {
      const client = resolve();
      const value = (client as unknown as Record<string | symbol, unknown>)[prop];
      // Los métodos se atan al cliente real: invocarlos a través del proxy
      // dejaría `this` apuntando al target vacío.
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(client)
        : value;
    },
    has: (_target, prop) => prop in resolve(),
  });
}

export const validatorDb: PgClient = lazyClient(getValidatorDb);

export const appDb: PgClient = lazyClient(getAppDb);

/**
 * Cierra ambos pools. Solo para CLI/tests; en Vercel no se llama.
 *
 * Solo cierra lo que llegó a abrirse: si un comando nunca tocó la base de la
 * app, no tiene caso instanciar su pool únicamente para cerrarlo.
 */
export async function closeConnections(): Promise<void> {
  const open = [globalThis.__validatorDb, globalThis.__appDb].filter(
    (client): client is PgClient => client !== undefined,
  );
  await Promise.allSettled(open.map((client) => client.end()));
  globalThis.__validatorDb = undefined;
  globalThis.__appDb = undefined;
}
