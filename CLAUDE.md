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
npm run etl ingest       # las 9 tablas, incremental (el paso que agenda el cron)
npm run etl ingest -- --full                      # carga inicial / re-sincronización
npm run etl ingest -- --tables=admConceptos,admAlmacenes
npm run etl documents | movements | catalogs      # subconjuntos históricos
npm run publish -- --dry-run                      # qué publicaría / retendría
npm run publish                                   # staging → app (9 tablas)
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
    sqlserver.ts         acceso SOLO LECTURA a AdminPAQ (consultas genéricas)
    column-maps.ts       columna ERP → columna app, por tabla (GENERADO + ajustes)
    tables.ts            registro de las 9 tablas: ERP ↔ staging ↔ app
    ingest-logic.ts      lógica pura: hash de fila, faltantes/borrados, deriva
    ingest.ts            motor de ingesta (una estrategia para las 9 tablas)
    sync.ts              pasos del ETL y control de corridas (sync_runs)
  services/
    validator.ts         orquestador de la validación
    publish-logic.ts     lógica pura: diff significativo, clasificación del cambio
    publisher.ts         staging → app con retención; resolución sync/keep
    folio-resolver.ts    resuelve folios contra la DB de la app
    verdicts.ts          memoria de decisiones humanas
    link-applier.ts      ÚNICO módulo que escribe en la DB de la app
  http/
    middleware.ts        auth, logging, errores
    routes/              review, anomalies, changes, internal
  cli/                   scripts de terminal
api/index.ts             punto de entrada de Vercel
```

## Reglas del proyecto

**AdminPAQ es de solo lectura.** Todo acceso a SQL Server es `SELECT`. El ERP
es la fuente de verdad contable y este servicio nunca le escribe.

**La ingesta es genérica.** Las 9 tablas que la app lee pasan por el mismo
motor (`etl/ingest.ts`) recorriendo el registro `etl/tables.ts`. Cada fila de
staging guarda la fila completa del ERP en `raw` (nombres originales de
AdminPAQ) más `source_hash`; `source_changed_at` solo avanza cuando la huella
cambia y es la señal que usa la publicación hacia la app. Para agregar una
columna: `column-maps.ts` + schema Drizzle de la app. Para agregar una tabla:
una entrada en `tables.ts` + su tabla de staging en una migración.

**`src/domain/` no hace I/O.** Las reglas son funciones puras: reciben datos,
devuelven anomalías. Sin base de datos, sin `env`, sin red. Es lo que permite
probarlas con casos reales y razonar sobre cada una por separado. Si una regla
necesita un umbral, entra como parámetro.

**Solo `link-applier.ts` y `publisher.ts` escriben en `appDb`.** El primero
escribe `comercial_document_links` (modo enforce y veredictos). El segundo
publica las 9 tablas `comercial_adm_*` desde staging y, al sincronizar una
cancelación o borrado, desactiva los vínculos del documento. Cualquier otra
escritura a la base de la app debe pasar por uno de los dos. Todo lo demás es
lectura.

**La app manda sobre lo que ya decidió.** Si un documento tiene vínculos en la
app (`comercial_document_links`, `comercial_movement_folio_links` o
`comercial_movement_unit_links` activos) y cambia, se cancela o se borra en el
ERP, el publicador NO lo toca: lo retiene en `published_rows.held_hash` y abre
un `source_changes` que la app muestra como "Modificado / Cancelado /
Eliminado en origen" con botones Sincronizar / Mantener. Cambios en columnas
sin importancia (CTIMESTAMP, usuario…) se publican en silencio.

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
