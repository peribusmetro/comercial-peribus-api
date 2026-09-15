import express, { type Express } from 'express';
import { env } from '@/config/env';
import {
  errorHandler,
  requestLogger,
  requireApiKey,
  requireInternalKey,
} from './http/middleware';
import { reviewRouter } from './http/routes/review';
import { anomaliesRouter } from './http/routes/anomalies';
import { internalRouter } from './http/routes/internal';

/**
 * Aplicación Express.
 *
 * Se exporta la app sin arrancar el listener para que Vercel pueda montarla
 * como función serverless (`api/index.ts`) y `server.ts` la levante en local.
 */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger);

  // Health check público: sin secretos ni consultas a base.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'comercial-peribus-api',
      mode: env.VALIDATOR_MODE,
      timestamp: new Date().toISOString(),
    });
  });

  // Endpoints de consulta y revisión: los usa la app Next.
  app.use('/review', requireApiKey, reviewRouter);
  app.use('/anomalies', requireApiKey, anomaliesRouter);

  // Endpoints internos: los dispara el cron de Supabase con una clave aparte.
  app.use('/internal', requireInternalKey, internalRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
  });

  app.use(errorHandler);

  return app;
}
