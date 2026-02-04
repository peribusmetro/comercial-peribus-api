import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ProductsService } from './products.service';
import { UpsertProductsDto } from './dto/upsert-products.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  async upsertProducts(@Body() upsertProductsDto: UpsertProductsDto) {
    return await this.productsService.upsertProducts(
      upsertProductsDto.products,
    );
  }

  @Get()
  async findAll() {
    return await this.productsService.findAll();
  }
}
