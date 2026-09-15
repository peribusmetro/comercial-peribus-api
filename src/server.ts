import { createApp } from './app';
import { env } from '@/config/env';

/**
 * Arranque local. En Vercel el punto de entrada es `api/index.ts`, que monta
 * la misma app sin abrir un listener.
 */
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`\n  comercial-peribus-api`);
  console.log(`  escuchando en http://localhost:${env.PORT}`);
  console.log(`  modo del validador: ${env.VALIDATOR_MODE}\n`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} recibido, cerrando…`);
  server.close(() => process.exit(0));

  // Si algo queda colgado, no se espera para siempre.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
