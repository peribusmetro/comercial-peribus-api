import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('comercial_products')
export class Product {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 256, nullable: true })
  state: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  family: string;

  @Column({ type: 'int', nullable: true, name: 'id_product' })
  idProduct: number;

  @Column({ type: 'varchar', length: 256, nullable: true, name: 'unit_of_average' })
  unitOfAverage: string;

  @Column({ type: 'varchar', length: 256, nullable: true, name: 'product_name' })
  productName: string;

  @Column({ type: 'varchar', length: 256, nullable: true, name: 'product_code' })
  productCode: string;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at', nullable: true })
  updatedAt: Date;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'int', default: 1 })
  active: number;
}
