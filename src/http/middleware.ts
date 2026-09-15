import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config/env';

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre un secreto se corta en el primer byte distinto, lo que filtra
 * información sobre el valor correcto. Aquí no.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractKey(req: Request): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  return null;
}

/** Protege los endpoints de lectura y revisión que consume la app Next. */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = extractKey(req);

  if (!key) {
    res.status(401).json({ error: 'Falta la API key' });
    return;
  }

  const valid = env.API_KEYS.some((candidate) => safeEqual(candidate, key));
  if (!valid) {
    res.status(401).json({ error: 'API key inválida' });
    return;
  }

  next();
}

/**
 * Protege /internal/*, que dispara sincronizaciones y escribe links.
 *
 * Usa una clave distinta de API_KEYS a propósito: si se filtra una clave de
 * lectura de la app, no debe poder disparar el ETL ni modificar vínculos.
 */
export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = extractKey(req);

  if (!key || !safeEqual(env.INTERNAL_API_KEY, key)) {
    // Mismo mensaje y código que una key ausente: no se confirma si existe.
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  next();
}

/** Envuelve handlers async para que los rechazos lleguen al error handler. */
export function asyncHandler<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req as T, res, next).catch(next);
  };
}

/** Log compacto de cada request. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });

  next();
}

/**
 * Manejador de errores final.
 *
 * En producción no se filtra el detalle del error al cliente: se registra en
 * los logs del servidor y el cliente recibe un mensaje genérico.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Error no controlado:', err);

  if (res.headersSent) return;

  res.status(500).json({
    error: 'Error interno',
    ...(env.NODE_ENV === 'production' ? {} : { detail: message }),
  });
}
