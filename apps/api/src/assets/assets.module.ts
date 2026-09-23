import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetSummaryService } from './asset-summary.service';

/** Fixed assets and depreciation (docs/01-architecture.md, module 6). */
@Module({
  imports: [FinanceModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetSummaryService],
  exports: [AssetsService],
})
export class AssetsModule {}
