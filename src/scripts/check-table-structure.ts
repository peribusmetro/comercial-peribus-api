import { config } from 'dotenv';
import { DataSource } from 'typeorm';

config(); // Cargar variables de entorno

async function checkTableStructure() {
  console.log('🔌 Intentando conectar con:');
  console.log('Host:', process.env.DB_HOST);
  console.log('Port:', process.env.DB_PORT);
  console.log('Database:', process.env.DB_NAME);
  console.log('Username:', process.env.DB_USERNAME);
  console.log('');

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    await dataSource.initialize();
    console.log('✅ Conexión establecida con éxito\n');

    const queryRunner = dataSource.createQueryRunner();

    // Consultar estructura de la tabla
    const columns = await queryRunner.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'comercial_products'
      ORDER BY ordinal_position;
    `);

    console.log('📋 Estructura de la tabla comercial_products:\n');
    console.table(columns);

    // Consultar datos de ejemplo
    const sampleData = await queryRunner.query(`
      SELECT * FROM comercial_products LIMIT 3;
    `);

    console.log('\n📊 Datos de ejemplo (primeros 3 registros):\n');
    console.log(JSON.stringify(sampleData, null, 2));

    await queryRunner.release();
    await dataSource.destroy();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkTableStructure();
