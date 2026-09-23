import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/** Bulk load of existing data from Excel/CSV. */
@Module({
  imports: [FinanceModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
