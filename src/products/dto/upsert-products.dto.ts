import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ProductInputDto } from './product-input.dto';

export class UpsertProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductInputDto)
  products: ProductInputDto[];
}
