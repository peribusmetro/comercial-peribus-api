import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config(); // Cargar variables de entorno

async function checkSupabaseTable() {
  console.log('🔌 Conectando a Supabase...\n');

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
  );

  try {
    console.log('Consultando estructura de la tabla usando SQL...\n');

    // Consultar la estructura de las columnas directamente desde information_schema
    const { data: columns, error: columnError } = await supabase.rpc('get_table_columns', {
      table_name_param: 'comercial_products'
    });

    // Si el RPC no existe, intentamos con una función SQL directa
    if (columnError) {
      console.log('Intentando consulta SQL directa...\n');

      // Usamos una query SQL para obtener la estructura
      const { data: sqlData, error: sqlError } = await supabase
        .from('comercial_products')
        .select('*')
        .limit(1);

      if (sqlError) {
        throw sqlError;
      }

      console.log('✅ Conexión exitosa\n');

      // Si hay datos, mostramos la estructura
      if (sqlData && sqlData.length > 0) {
        console.log('📊 Estructura detectada de comercial_products:\n');
        const fields = Object.keys(sqlData[0]);
        fields.forEach((field) => {
          const value = sqlData[0][field];
          const jsType = value === null ? 'null' : typeof value;
          console.log(`  - ${field}: ${jsType}`);
        });
      } else {
        console.log('⚠️  La tabla está vacía. Consultando metadatos del sistema...\n');

        // Intentar obtener columnas mediante una query raw
        console.log('Necesitamos crear una función RPC en Supabase para obtener la estructura.');
        console.log('\nPor favor ejecuta esta función SQL en Supabase SQL Editor:\n');
        console.log('-------------------------------------------------------------------');
        console.log(`
CREATE OR REPLACE FUNCTION get_table_columns(table_name_param TEXT)
RETURNS TABLE (
  column_name TEXT,
  data_type TEXT,
  is_nullable TEXT,
  column_default TEXT,
  character_maximum_length INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.column_name::TEXT,
    c.data_type::TEXT,
    c.is_nullable::TEXT,
    c.column_default::TEXT,
    c.character_maximum_length
  FROM information_schema.columns c
  WHERE c.table_name = table_name_param
  ORDER BY c.ordinal_position;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
        `);
        console.log('-------------------------------------------------------------------');
        console.log('\nLuego ejecuta este script de nuevo.');
      }
    } else {
      console.log('✅ Estructura de columnas obtenida:\n');
      console.table(columns);
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkSupabaseTable();
