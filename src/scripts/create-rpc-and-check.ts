import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config(); // Cargar variables de entorno

async function createRPCAndCheck() {
  console.log('🔌 Conectando a Supabase...\n');

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!,
    {
      db: {
        schema: 'public',
      },
    }
  );

  try {
    // Intentar crear la función RPC usando SQL
    console.log('Creando función RPC para consultar columnas...\n');

    const createFunctionSQL = `
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
    `;

    // Intentar ejecutar el SQL directamente
    const { error: createError } = await supabase.rpc('exec_sql', {
      query: createFunctionSQL
    });

    if (createError) {
      console.log('⚠️  No se pudo crear la función RPC automáticamente.');
      console.log('Error:', createError.message);
      console.log('\nIntentando método alternativo con consulta directa...\n');

      // Método alternativo: consultar usando el servicio REST de PostgreSQL
      const { data: columnsData, error: columnsError } = await supabase
        .from('information_schema.columns')
        .select('column_name, data_type, is_nullable, column_default, character_maximum_length')
        .eq('table_name', 'comercial_products')
        .order('ordinal_position');

      if (columnsError) {
        console.log('❌ Tampoco funcionó el método alternativo.');
        console.log('Error:', columnsError.message);
        console.log('\nÚltimo intento: Usando SQL raw...\n');
      } else {
        console.log('✅ Estructura obtenida mediante consulta directa:\n');
        console.table(columnsData);
        return;
      }
    }

    // Si llegamos aquí, intentamos usar la función que creamos
    console.log('Consultando estructura de la tabla...\n');

    const { data: columns, error: queryError } = await supabase.rpc('get_table_columns', {
      table_name_param: 'comercial_products'
    });

    if (queryError) {
      throw queryError;
    }

    console.log('✅ Estructura de columnas de comercial_products:\n');
    console.table(columns);

  } catch (error: any) {
    console.error('❌ Error final:', error.message);
    console.log('\n📋 Por favor, copia la estructura de la tabla desde Supabase Dashboard y pégala aquí.');
    process.exit(1);
  }
}

createRPCAndCheck();
