import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Validación de entorno.
 *
 * Se valida al arrancar, no al usar: si falta una variable preferimos que el
 * proceso no levante a que falle a las 3am a media corrida.
 *
 * Las variables de SQL Server son opcionales porque la API desplegada en
 * Vercel (endpoints de revisión) no necesita hablar con AdminPAQ — solo el
 * paso de ETL lo hace. `requireSqlServer()` las exige cuando toca.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // --- DB propia del validador (Supabase aparte) ---
  VALIDATOR_DATABASE_URL: z
    .string()
    .min(1, 'VALIDATOR_DATABASE_URL es obligatoria (Postgres del validador)'),

  // --- Supabase de la app Next: aquí se escriben los links ---
  APP_DATABASE_URL: z
    .string()
    .min(1, 'APP_DATABASE_URL es obligatoria (Postgres de peribus-incidents-admin)'),

  // --- SQL Server / AdminPAQ (solo lo necesita el ETL) ---
  SQL_SERVER_HOST: z.string().optional(),
  SQL_SERVER_PORT: z.coerce.number().int().positive().default(1433),
  SQL_SERVER_USER: z.string().optional(),
  SQL_SERVER_PASSWORD: z.string().optional(),
  SQL_SERVER_DATABASE: z.string().default('adPERIBUS_METROPOLITAN'),

  // --- Seguridad ---
  // Claves que pueden llamar endpoints públicos de lectura/revisión.
  API_KEYS: z
    .string()
    .min(1, 'API_KEYS es obligatoria')
    .transform((raw) => raw.split(',').map((k) => k.trim()).filter(Boolean)),

  // Clave separada y exclusiva para /internal/* (la usa el cron de Supabase).
  // Se mantiene aparte de API_KEYS para que una clave de lectura filtrada no
  // permita disparar sincronizaciones ni escribir links.
  INTERNAL_API_KEY: z
    .string()
    .min(16, 'INTERNAL_API_KEY debe tener al menos 16 caracteres'),

  // --- Comportamiento del validador ---
  // audit   → detecta y reporta, NO escribe links (modo inicial acordado)
  // enforce → además aplica links y cuarentena
  VALIDATOR_MODE: z.enum(['audit', 'enforce']).default('audit'),

  // Días de diferencia entre captura y modificación para disparar R4.
  LATE_RELINK_DAYS: z.coerce.number().int().positive().default(14),
});

export type AppEnv = z.infer<typeof schema>;

function parseEnv(): AppEnv {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  · ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }

  return parsed.data;
}

/**
 * Entorno validado, resuelto de forma perezosa.
 *
 * La validación sigue siendo estricta —una variable faltante hace fallar— pero
 * el error se lanza al *usar* `env`, no al importar el módulo. La diferencia
 * importa en serverless: con la validación en el import, un solo valor mal
 * puesto tumbaba la función completa y hasta `/health` devolvía un 500 opaco,
 * justo cuando más falta hace poder preguntar qué está mal. Ahora el fallo
 * queda acotado a quien de verdad necesita la configuración.
 *
 * El resultado se memoiza: se valida una vez por proceso, no por acceso.
 */
let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= parseEnv();
  return cachedEnv;
}

export const env: AppEnv = new Proxy({} as AppEnv, {
  get: (_target, prop) => getEnv()[prop as keyof AppEnv],
  has: (_target, prop) => prop in getEnv(),
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_target, prop) =>
    Reflect.getOwnPropertyDescriptor(getEnv(), prop),
});

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

/**
 * Credenciales de SQL Server, exigidas solo cuando se va a correr el ETL.
 * Devuelve la config ya armada para `mssql`.
 */
export function requireSqlServerConfig() {
  const { SQL_SERVER_HOST, SQL_SERVER_USER, SQL_SERVER_PASSWORD } = env;

  if (!SQL_SERVER_HOST || !SQL_SERVER_USER || !SQL_SERVER_PASSWORD) {
    throw new Error(
      'Faltan credenciales de SQL Server (SQL_SERVER_HOST / _USER / _PASSWORD). ' +
        'Son obligatorias para los pasos de ETL.',
    );
  }

  // AdminPAQ puede exponerse como HOST\INSTANCIA o como HOST + puerto.
  const hasNamedInstance = SQL_SERVER_HOST.includes('\\');
  const [serverName, instanceName] = hasNamedInstance
    ? SQL_SERVER_HOST.split('\\')
    : [SQL_SERVER_HOST, undefined];

  return {
    server: serverName,
    user: SQL_SERVER_USER,
    password: SQL_SERVER_PASSWORD,
    database: env.SQL_SERVER_DATABASE,
    ...(hasNamedInstance
      ? { options: { instanceName, encrypt: false, trustServerCertificate: true } }
      : {
          port: env.SQL_SERVER_PORT,
          options: { encrypt: false, trustServerCertificate: true },
        }),
    connectionTimeout: 30_000,
    requestTimeout: 120_000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
  };
}
