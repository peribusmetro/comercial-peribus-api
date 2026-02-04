# Comercial Peribus API - Colección de Bruno

Esta colección contiene todos los endpoints disponibles en la API de Comercial Peribus para facilitar las pruebas.

## 📋 Endpoints Disponibles

### 1. **Health Check (Public)**
- **Método**: GET
- **URL**: `/`
- **Autenticación**: No requiere
- **Descripción**: Endpoint público para verificar que la API está funcionando

### 2. **Get All Products**
- **Método**: GET
- **URL**: `/products`
- **Autenticación**: Requiere API Key
- **Descripción**: Obtiene todos los productos de la tabla comercial_products

### 3. **Upsert Products**
- **Método**: POST
- **URL**: `/products/upsert`
- **Autenticación**: Requiere API Key
- **Descripción**: Crea o actualiza productos basándose en `idProduct`
- **Body**: Array de productos con campos opcionales

### 4. **Get Products - Bearer Token**
- **Método**: GET
- **URL**: `/products`
- **Autenticación**: Bearer Token
- **Descripción**: Ejemplo alternativo de autenticación usando Authorization Bearer

### 5. **Get Products - Without API Key**
- **Método**: GET
- **URL**: `/products`
- **Autenticación**: Ninguna
- **Descripción**: Prueba de error 401 sin API Key

## 🔐 Autenticación

La API soporta dos métodos de autenticación:

1. **Header personalizado**:
   ```
   X-API-Key: sk_comercial_2024_abc123def456
   ```

2. **Bearer Token**:
   ```
   Authorization: Bearer sk_comercial_2024_abc123def456
   ```

## 🌍 Entornos

### Local
- **Base URL**: `http://localhost:3000`
- **API Key**: `sk_comercial_2024_abc123def456`

## 🚀 Uso

1. Abre Bruno
2. Importa la colección desde la carpeta `bruno/comercial-peribus-api`
3. Selecciona el entorno "Local"
4. Ejecuta los requests

## 📝 Notas

- Los endpoints protegidos requieren API Key válida
- El endpoint `/` es público y no requiere autenticación
- El upsert detecta cambios automáticamente y solo actualiza cuando es necesario
- Los campos `id`, `created_at`, `updated_at` y `active` se generan automáticamente
