# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio.

## Qué es este proyecto

Servicio **validador** entre AdminPAQ (SQL Server) y `peribus-incidents-admin`.
No es un CRUD ni un proxy: trae documentos del ERP a su propia base, los
analiza contra un motor de reglas, y solo asigna a folios de mantenimiento los
que no presentan anomalías. El resto queda en cuarentena para revisión humana.

El contexto completo del problema está en `README.md`.

## Comandos

```bash
npm run dev              # servidor con recarga (tsx watch)
npm run build            # tsc + tsc-alias + copia de .sql
npm start                # producción (dist/src/server.js)
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run lint             # eslint --fix

npm run db:migrate       # aplica migraciones a la DB del validador
npm run check:coverage   # diagnóstico de cobertura del campo unidad
npm run etl <paso>       # documents | movements | catalogs | all
```

## Arquitectura

```
src/
  config/env.ts          validación de entorno con zod; falla al arrancar
  db/
    clients.ts           dos pools: validatorDb (propia) y appDb (la de la app)
    migrate.ts           runner de migraciones
    migrations/*.sql     esquema y semillas
  domain/                NÚCLEO — funciones puras, sin I/O
    normalize.ts         parseo de folios, ecos y timestamps de AdminPAQ
    rules.ts             las 6 reglas + fingerprint
    types.ts
  etl/
    sqlserver.ts         acceso SOLO LECTURA a AdminPAQ
    sync.ts              ETL por pasos, idempotente
  services/
    validator.ts         orquestador de la validación
    folio-resolver.ts    resuelve folios contra la DB de la app
    verdicts.ts          memoria de decisiones humanas
    link-applier.ts      ÚNICO módulo que escribe en la DB de la app
  http/
    middleware.ts        auth, logging, errores
    routes/              review, anomalies, internal
  cli/                   scripts de terminal
api/index.ts             punto de entrada de Vercel
```

## Reglas del proyecto

**AdminPAQ es de solo lectura.** Todo acceso a SQL Server es `SELECT`. El ERP
es la fuente de verdad contable y este servicio nunca le escribe.

**`src/domain/` no hace I/O.** Las reglas son funciones puras: reciben datos,
devuelven anomalías. Sin base de datos, sin `env`, sin red. Es lo que permite
probarlas con casos reales y razonar sobre cada una por separado. Si una regla
necesita un umbral, entra como parámetro.

**Solo `link-applier.ts` escribe en `appDb`.** Cualquier otra escritura a la
base de la app debe pasar por ahí. Todo lo demás es lectura.

**Dos claves de API distintas.** `API_KEYS` para lectura/revisión (las usa la
app Next); `INTERNAL_API_KEY` para `/internal/*`. Si se filtra una clave de
lectura, no debe poder disparar el ETL ni modificar vínculos.

**Los endpoints internos responden 202.** `pg_net` y Vercel tienen timeouts
cortos. El trabajo sigue en segundo plano y el seguimiento se hace por
`sync_runs`, no por la respuesta HTTP.

**Modo `audit` por defecto.** No escribe links, solo detecta. Cambiar a
`enforce` es una decisión explícita.

## Detalles de AdminPAQ que importan

- `CTIMESTAMP` es **texto** `MM/DD/YYYY`, no una fecha. Comparar con
  `CONVERT(DATETIME, CTIMESTAMP, 101)`.
- `'12/30/1899 00:00:00:000'` es el centinela de "sin valor".
- Solo `admDocumentos` y `admExistenciaCosto` tienen `CTIMESTAMP`. El resto se
  sincroniza comparando IDs.
- Los campos libres se capturan a mano: `tp-1`, `M--250814-54`,
  `260602-94 260611-5`, `AP-119 COSTO X KILOMETRO`. Los normalizadores de
  `src/domain/normalize.ts` replican la lógica de la app
  (`features/comercial/utils/`). **Si se cambia aquí, hay que cambiarlo allá.**

## Consistencia con la app

`comercial_document_links` vive en el Supabase de `peribus-incidents-admin`,
no en la base del validador: tiene FK a `maintenances.id` y más de veinte
consultas de la app le hacen JOIN directo.

La unidad de un folio se resuelve por `maintenances → incidents → units`
(LEFT JOIN: un mantenimiento puede no tener incidente).

Al insertar links, el `NOT EXISTS` mira **todas** las filas del par
(documento, folio), activas o no. Una fila con `active = 0` significa que
alguien desvinculó a mano porque el folio del ERP estaba mal; volver a ligarlo
desharía esa corrección.

## Fuera de alcance

Los **siniestros**. La tabla `accidents` está vacía y la FK apunta ahí; los
siniestros reales viven en `incident_types` con `pid 'S-%'`. Habilitarlos
requiere una migración del lado de la app.
