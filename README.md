# comercial-peribus-api

Servicio intermedio entre **AdminPAQ** (SQL Server) y **peribus-incidents-admin**.

No es un proxy de datos: es un **validador**. Trae los documentos del ERP a su
propia base, los analiza, y solo asigna a folios de mantenimiento aquellos que
no presentan anomalías. Lo que no pasa la revisión queda en cuarentena y se
reporta para que compras lo corrija.

---

## El problema que resuelve

El auto-link anterior ligaba un documento a un folio con solo empatar el texto
de `extra_text_three`. Sin verificar nada más. Eso produjo casos como el folio
`M-260723-67`:

- **$73,108** acumulados entre 13 documentos
- Documentos de las unidades **AP-057** y **AP-084** en un folio de **AP-087**
- Una **compra a stock de $30,064.95** cargada íntegra al folio
- **Tres clutchs distintos** (códigos `MTO-1319`, `MTO-0037`, `MTO-0947`)

Como los tres clutchs tenían códigos diferentes, ningún detector de duplicados
exactos los veía: el sistema reportaba `duplicate_count: 0`.

---

## Arquitectura

```
SQL Server (AdminPAQ)          ← solo lectura, nunca se le escribe
        │
        ▼
  ETL por pasos
        │
        ▼
DB propia del validador        ← staging, anomalías, cuarentena, veredictos
        │
        ▼
  Motor de reglas
        │
   ┌────┴────┐
 limpio   sospechoso
   │          │
   ▼          ▼
Supabase   cuarentena  →  la app Next lo muestra  →  compras corrige
de la app                                              en AdminPAQ
(links)
```

`comercial_document_links` se queda en el Supabase de la app —no se muda a la
base del validador— porque tiene FK a `maintenances.id` y más de veinte
consultas de la app le hacen JOIN directo. El validador es el único que la
escribe.

---

## Las reglas

| Código | Regla | Acción | Origen |
|---|---|---|---|
| **R1** | Unidad del documento ≠ unidad del folio | cuarentena | COMDU 6771 (TP-062) en folio de TP-082 |
| **R2** | Compra a stock / almacén | cuarentena | FP10181, $30,064.95 |
| **R3** | Documento con varias unidades | cuarentena | "AP-035, AP-100 STOCK" |
| **R4** | Folio modificado semanas después | marca | capturado 24 jul, modificado 28 ago |
| **R5** | Folio sin prefijo M-/S- | marca | `260715-29` |
| **R6** | Dos piezas mayores del mismo grupo | cuarentena | 3 clutchs en M-260723-67 |

**R1 es la regla principal.** Un folio pertenece a una unidad; si el documento
declara otra, no es su gasto. Es determinista, sin umbrales ni estadística.

**Cuarentena** significa que el documento **no se liga**. El folio queda con el
gasto incompleto pero limpio, en vez de completo pero inflado.

**R6 retiene el grupo completo**, no "el más probable": cuando hay tres clutchs,
la regla sabe que algo está mal pero no cuál es el bueno. En `M-260723-67`
ninguno de los tres lo era.

---

## Memoria de decisiones

Cuando alguien revisa un caso en la app y da el visto bueno, queda escrito en
`review_verdicts` y el validador **no lo vuelve a marcar**.

El veredicto se ata al `source_fingerprint` del documento (unidad, folio, total,
productos). Si compras lo edita en AdminPAQ, la huella cambia y el veredicto
**caduca solo**. Un "aprobado" no puede tapar para siempre un documento que
después se convirtió en otra cosa.

Alcances:
- `this_pair` — solo ese documento con ese folio
- `document` — ese documento contra cualquier folio
- `rule_for_folio` — perdona una regla en todo el folio (ej. "este autobús sí
  llevó dos clutchs, fue reparación mayor")

---

## Puesta en marcha

### 1. Configurar el entorno

```bash
cp .env.example .env
```

Llenar:
- `VALIDATOR_DATABASE_URL` — Postgres del validador (proyecto Supabase aparte).
  Usar la URL del **pooler** (puerto 6543), no la directa.
- `APP_DATABASE_URL` — Postgres de peribus-incidents-admin.
- `SQL_SERVER_*` — credenciales de AdminPAQ.
- `API_KEYS` — claves de lectura, las usa la app Next.
- `INTERNAL_API_KEY` — clave aparte, solo para el cron.

### 2. Crear el esquema

```bash
npm install
npm run db:migrate
```

### 3. Diagnóstico previo (importante)

```bash
npm run check:coverage
```

Mide qué porcentaje de documentos trae unidad reconocible en el ERP. **R1 y R3
dependen por completo de ese dato.** Si la cobertura es baja, hay que reforzar
la captura antes de confiar en el validador. Solo lee, no escribe nada.

### 4. Primera carga

```bash
npm run etl documents -- --full
npm run etl movements
npm run etl catalogs
```

### 5. Auditoría

El modo por defecto es `audit`: detecta y reporta **sin escribir links**.

```bash
curl -X POST -H "X-API-Key: $INTERNAL_API_KEY" \
  "$API_URL/internal/run?step=validate"

curl -H "X-API-Key: $API_KEY" "$API_URL/anomalies/stats"
```

Eso da el número para llevar a compras: cuántos folios están afectados y cuánto
dinero representa.

**Ojo con el alcance de una corrida.** El paso `validate` evalúa como máximo
5,000 documentos, los más recientes por fecha, y no pagina. Para auditar el
histórico completo hay que pasar un límite mayor, que el endpoint no expone:

```ts
import { runValidation } from './src/services/validator';
await runValidation({ limit: 25000, mode: 'audit' });
```

### 6. Pasar a enforce

Cuando las reglas estén calibradas, cambiar `VALIDATOR_MODE=enforce`. A partir
de ahí el validador escribe los links y aplica la cuarentena.

---

## Estado de la puesta en marcha

Al **17 de septiembre de 2026**, corrido contra el AdminPAQ de producción y
desplegado en Vercel. Modo `audit`: **no se ha escrito ningún link todavía**.

### Cobertura del ERP (`npm run check:coverage`)

53,708 documentos no cancelados. De los 20,398 que traen folio capturado:

| Dato | Cobertura | Implicación |
|---|---|---|
| Unidad reconocible | **92.2%** | **R1 es viable** — la regla principal se puede aplicar |
| Folio sin prefijo | 57.6% | R5 lo marca, no lo pone en cuarentena |
| Declara varias unidades | 1.1% | alcance de R3 |
| Menciona stock/almacén | 0.4% | alcance de R2 |

El 57.6% de folios ambiguos es alto pero no bloquea: se interpretan como
mantenimiento (`folio-resolver` solo resuelve `M-`) y quedan marcados para
revisión humana.

### Resultado de la auditoría

20,399 documentos evaluados, 15,387 pares documento-folio:

| Regla | Casos | Folios | Monto |
|---|---|---|---|
| R5 — folio ambiguo | 317 | 239 | $964,880 |
| R4 — re-ligado tardío | 77 | 76 | $246,890 |
| R1 — unidad discordante | **31** | 29 | $51,387 |
| R3 — documento multi-unidad | **24** | 24 | $197,360 |
| R6 — pieza mayor duplicada | 18 | 16 | $157,509 |
| R2 — compra a stock | **2** | 2 | $60,130 |

**253 folios afectados**, 254 documentos y **$679,170 en riesgo** (suma de los
documentos distintos con anomalía; los montos por regla de arriba no se pueden
sumar entre sí, porque un documento puede infringir varias). En cuarentena: 75;
marcados: 394.

El caso fundacional `M-260723-67` **ya no aparece**: sus 12 documentos ahora
declaran todos `AP-087`, la unidad correcta. Compras lo corrigió en el ERP y el
validador lo confirma — que es exactamente el ciclo que se buscaba.

### Falta

- Agendar el cron de Supabase (`supabase/cron.sql`); hoy nada corre solo.
- Calibrar con compras y decidir el paso a `enforce`.

---

## Endpoints

### Revisión (requieren `API_KEYS`)

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/review/pending` | Bandeja de casos por revisar |
| `GET` | `/review/folio/:pid` | Todo lo detectado en un folio |
| `POST` | `/review/verdict` | Registrar una decisión humana |
| `GET` | `/review/history/:documentId` | Historial de un documento |

### Anomalías (requieren `API_KEYS`)

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/anomalies/stats` | Resumen agregado (el reporte para compras) |
| `GET` | `/anomalies/document/:id` | Banderas de un documento |
| `GET` | `/anomalies/flags?documentIds=1,2,3` | Banderas en lote, para la tabla |
| `GET` | `/anomalies/runs` | Historial de corridas |

### Internos (requieren `INTERNAL_API_KEY`)

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/internal/run?step=documents\|movements\|catalogs\|validate` | Dispara un paso |
| `GET` | `/internal/status` | Estado de la última corrida de cada paso |

Los pasos responden **202 de inmediato** y trabajan en segundo plano: `pg_net`
y las funciones de Vercel tienen timeouts cortos. El seguimiento real se hace
por `sync_runs`, no por la respuesta HTTP.

---

## Despliegue

### Vercel

```bash
vercel --prod
```

Configurar las variables de entorno en el panel. **La API necesita alcanzar el
SQL Server de AdminPAQ**; hoy eso funciona porque el host es público en el
puerto 1433 (es como corre el sync actual desde GitHub Actions).

### Cron de Supabase

Ver `supabase/cron.sql`. Agenda cuatro pasos a partir de las 03:00 MX
(09:00 UTC), separados 5 minutos. Las credenciales van en Vault, no en texto
plano.

---

## Desarrollo

```bash
npm run dev          # servidor con recarga
npm test             # 54 tests del motor de reglas
npm run typecheck    # verificación de tipos
npm run build        # compila a dist/
```

Las reglas (`src/domain/rules.ts`) son **funciones puras**: sin base de datos,
sin variables de entorno. Se prueban con los casos reales documentados en
`src/domain/rules.test.ts`.

---

## Notas

**Siniestros fuera de alcance.** La tabla `accidents` de la app está vacía y la
FK de `comercial_document_links` apunta ahí. Los siniestros reales viven en
`incident_types` con `pid 'S-%'`. Habilitarlos requiere una migración del lado
de la app.

**El ERP no se modifica.** Todo el acceso a AdminPAQ es `SELECT`. Las
correcciones las hace compras en el ERP, y el validador las detecta en la
siguiente corrida.
