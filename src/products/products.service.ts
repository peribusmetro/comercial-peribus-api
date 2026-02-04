import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ProductInputDto } from './dto/product-input.dto';

@Injectable()
export class ProductsService {
  private supabase: SupabaseClient;

  constructor() {
    // Usar service_role key si está disponible, de lo contrario usar anon key
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY!;

    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      supabaseKey,
    );
  }

  /**
   * Obtiene la fecha/hora actual en zona horaria de Ciudad de México
   */
  private getMexicoCityDateTime(): string {
    const now = new Date();
    // Convertir a zona horaria de Ciudad de México usando Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Mexico_City',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';

    // Formato: YYYY-MM-DDTHH:mm:ss
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  }

  async upsertProducts(productsData: ProductInputDto[]): Promise<{
    created: number;
    updated: number;
    total: number;
  }> {
    let created = 0;
    let updated = 0;

    for (const productData of productsData) {
      // Convertir camelCase a snake_case para Supabase
      const dbData = {
        id_product: productData.idProduct,
        state: productData.state,
        family: productData.family,
        unit_of_average: productData.unitOfAverage,
        product_name: productData.productName,
      };

      // Buscar producto existente por id_product
      const { data: existingProducts, error: fetchError } = await this.supabase
        .from('comercial_products')
        .select('*')
        .eq('id_product', productData.idProduct)
        .limit(1);

      if (fetchError) {
        throw new Error(`Error fetching product: ${fetchError.message}`);
      }

      if (existingProducts && existingProducts.length > 0) {
        const existingProduct = existingProducts[0];

        // Verificar si hay cambios
        const hasChanges = this.hasProductChanges(existingProduct, dbData);

        if (hasChanges) {
          // Actualizar producto existente
          const { error: updateError } = await this.supabase
            .from('comercial_products')
            .update({
              ...dbData,
              updated_at: this.getMexicoCityDateTime(),
            })
            .eq('id_product', productData.idProduct);

          if (updateError) {
            throw new Error(`Error updating product: ${updateError.message}`);
          }
          updated++;
        }
      } else {
        // Crear nuevo producto
        const { error: insertError } = await this.supabase
          .from('comercial_products')
          .insert({
            ...dbData,
            active: 1,
            created_at: this.getMexicoCityDateTime(),
          });

        if (insertError) {
          throw new Error(`Error creating product: ${insertError.message}`);
        }
        created++;
      }
    }

    return {
      created,
      updated,
      total: productsData.length,
    };
  }

  async findAll(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('comercial_products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Error fetching products: ${error.message}`);
    }

    return data || [];
  }

  private hasProductChanges(existing: any, incoming: any): boolean {
    return (
      existing.state !== incoming.state ||
      existing.family !== incoming.family ||
      existing.unit_of_average !== incoming.unit_of_average ||
      existing.product_name !== incoming.product_name
    );
  }
}
