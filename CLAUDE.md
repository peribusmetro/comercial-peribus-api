# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos de Desarrollo

### Construcción y Ejecución
```bash
npm run build                # Compilar el proyecto
npm run start                # Iniciar en modo producción
npm run start:dev            # Iniciar en modo desarrollo con watch
npm run start:debug          # Iniciar con debugger y watch
```

### Testing
```bash
npm run test                 # Ejecutar tests unitarios
npm run test:watch           # Ejecutar tests en modo watch
npm run test:cov             # Ejecutar tests con cobertura
npm run test:e2e             # Ejecutar tests end-to-end
npm run test:debug           # Ejecutar tests con debugger
```

### Calidad de Código
```bash
npm run lint                 # Ejecutar ESLint con auto-fix
npm run format               # Formatear código con Prettier
```

## Arquitectura

### Framework y Stack
- **Framework**: NestJS 11 con TypeScript
- **Base de datos**: PostgreSQL (Supabase) con TypeORM
- **Puerto por defecto**: 3000 (configurable vía `process.env.PORT`)
- **Arquitectura**: Modular basada en controladores, servicios y módulos de NestJS

### Configuración de TypeScript
- **Target**: ES2023 con módulos NodeNext
- **Modo estricto activado**: `strictNullChecks`, `noImplicitAny`, `strictBindCallApply`
- **Decoradores experimentales**: Habilitados para NestJS
- **Source maps**: Habilitados para debugging

### Estructura del Proyecto
- `src/`: Código fuente principal
  - `main.ts`: Punto de entrada de la aplicación (incluye validación global y CORS)
  - `app.module.ts`: Módulo raíz de la aplicación (incluye configuración de TypeORM y ConfigModule)
  - `app.controller.ts`: Controlador principal
  - `app.service.ts`: Servicio principal
  - `config/`: Archivos de configuración
    - `database.config.ts`: Configuración de TypeORM para Supabase
    - `supabase.config.ts`: Configuración del cliente de Supabase
  - `scripts/`: Scripts de utilidad para consultar la base de datos
- `test/`: Tests end-to-end
- `dist/`: Salida de compilación (generado)

### Base de Datos y Supabase
- **ORM**: TypeORM configurado para PostgreSQL
- **Conexión**:
  - Las credenciales se configuran en archivo `.env` (nunca commitear este archivo)
  - Ver `.env.example` para las variables requeridas
  - SSL habilitado por defecto para conexión con Supabase
- **Entidades**:
  - Deben crearse con decorador `@Entity()` de TypeORM
  - Ubicarlas en sus respectivos módulos o en `src/common/` para uso compartido
  - Usar `*.entity.ts` como sufijo de archivo
  - TypeORM sincroniza automáticamente en desarrollo (`synchronize: true`)
- **Migraciones**: En producción desactivar `synchronize` y usar migraciones de TypeORM

### Variables de Entorno
Configurar en archivo `.env` (copiar desde `.env.example`):
- `SUPABASE_URL`: URL del proyecto de Supabase
- `SUPABASE_KEY`: Anon/Public key de Supabase
- `DB_HOST`: Host de PostgreSQL (formato: `db.xxx.supabase.co`)
- `DB_PORT`: Puerto de PostgreSQL (por defecto 5432)
- `DB_USERNAME`: Usuario de la base de datos (por defecto `postgres`)
- `DB_PASSWORD`: Contraseña de la base de datos
- `DB_NAME`: Nombre de la base de datos (por defecto `postgres`)

### Testing
- **Framework**: Jest 30
- **Configuración**:
  - Tests unitarios buscan archivos `*.spec.ts` en `src/`
  - Tests e2e usan configuración separada en `test/jest-e2e.json`
  - Cobertura se genera en directorio `coverage/`

### Validación
- **Validación global activada** en `main.ts` usando `ValidationPipe`
- **class-validator** y **class-transformer** instalados
- **Configuración**:
  - `whitelist: true` - Remueve propiedades no definidas en el DTO
  - `forbidNonWhitelisted: true` - Lanza error si hay propiedades extra
  - `transform: true` - Transforma payloads a instancias de DTO
