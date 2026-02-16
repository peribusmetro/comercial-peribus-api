import { IsString, IsInt, IsOptional, MaxLength } from 'class-validator';

export class ProductInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  family?: string;

  @IsInt()
  idProduct: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  unitOfAverage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  productName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  productCode?: string;
}
