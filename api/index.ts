import { createApp } from '../src/app';

/**
 * Punto de entrada para Vercel.
 *
 * Vercel monta el export default como handler de la función serverless.
 * La app se crea una sola vez por instancia; los pools de Postgres se
 * reutilizan entre invocaciones (ver src/db/clients.ts).
 */
export default createApp();
