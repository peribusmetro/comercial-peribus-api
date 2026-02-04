import { config } from 'dotenv';
import { DataSource } from 'typeorm';

config(); // Cargar variables de entorno

async function queryTableStructure() {
  console.log('🔌 Intentando conectar a PostgreSQL de Supabase...\n');

  // Intentar primero con el pooler
  const poolerConfig = {
    type: 'postgres' as const,
    host: process.env.DB_POOLER_HOST,
    port: parseInt(process.env.DB_POOLER_PORT || '6543', 10),
    username: process.env.DB_POOLER_USERNAME,
    password: process.env.DB_POOLER_PASSWORD,
    database: process.env.DB_POOLER_NAME,
    ssl: {
      rejectUnauthorized: false,
    },
  };

  console.log('Configuración de conexión (Pooler):');
  console.log(`Host: ${poolerConfig.host}`);
  console.log(`Port: ${poolerConfig.port}`);
  console.log(`User: ${poolerConfig.username}`);
  console.log(`DB: ${poolerConfig.database}\n`);

  let dataSource = new DataSource(poolerConfig);

  try {
    console.log('Conectando via Pooler (puerto 6543)...');
    await dataSource.initialize();
    console.log('✅ Conexión exitosa via Pooler\n');
  } catch (poolerError: any) {
    console.log('⚠️  Pooler falló:', poolerError.message);
    console.log('\nIntentando conexión directa (puerto 5432)...\n');

    // Intentar conexión directa
    const directConfig = {
      type: 'postgres' as const,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: {
        rejectUnauthorized: false,
      },
    };

    console.log('Configuración de conexión (Directa):');
    console.log(`Host: ${directConfig.host}`);
    console.log(`Port: ${directConfig.port}`);
    console.log(`User: ${directConfig.username}`);
    console.log(`DB: ${directConfig.database}\n`);

    dataSource = new DataSource(directConfig);

    try {
      await dataSource.initialize();
      console.log('✅ Conexión exitosa via conexión directa\n');
    } catch (directError: any) {
      console.error('❌ Error en conexión directa:', directError.message);
      console.log('\n📋 No se pudo establecer conexión directa a PostgreSQL.');
      console.log('Esto es normal en Supabase desde desarrollo local.');
      console.log('\nPor favor, proporciona manualmente las columnas de la tabla comercial_products');
      process.exit(1);
    }
  }

  try {
    const queryRunner = dataSource.createQueryRunner();

    // Consultar estructura de la tabla
    console.log('Consultando estructura de comercial_products...\n');

    const columns = await queryRunner.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default,
        udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'comercial_products'
      ORDER BY ordinal_position;
    `);

    if (columns.length === 0) {
      console.log('⚠️  No se encontró la tabla comercial_products en el esquema public');
      console.log('\nVerificando todas las tablas disponibles...\n');

      const tables = await queryRunner.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `);

      console.log('Tablas encontradas:');
      console.table(tables);
    } else {
      console.log('✅ Estructura de comercial_products:\n');
      console.table(columns);

      // Intentar obtener un registro de ejemplo
      console.log('\nConsultando datos de ejemplo...\n');
      const sampleData = await queryRunner.query(`
        SELECT * FROM comercial_products LIMIT 3;
      `);

      if (sampleData.length > 0) {
        console.log('📊 Datos de ejemplo:\n');
        console.log(JSON.stringify(sampleData, null, 2));
      } else {
        console.log('ℹ️  La tabla está vacía (sin registros)');
      }
    }

    await queryRunner.release();
    await dataSource.destroy();
    console.log('\n✅ Proceso completado');
  } catch (error: any) {
    console.error('❌ Error al consultar:', error.message);
    await dataSource.destroy();
    process.exit(1);
  }
}

queryTableStructure();
