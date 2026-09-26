import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { BranchesController } from './branches.controller';
import { UsersController } from './admin.controllers';
import { RbacController } from './rbac.controller';
import { OrgController } from './org.controller';
import { FiscalController } from './fiscal.controller';

/**
 * Admin domain: the shape of the group (organisation, countries, offices, departments),
 * its people, who may do what, the audit trail — docs/01-architecture.md, module 11 — and,
 * since migration 028, the Finance / Fiscal Configuration screen (legal entities and
 * jurisdiction/tax compliance profiles — docs/FISCAL_COMPLIANCE.md).
 */
@Module({
  imports: [FinanceModule],
  controllers: [BranchesController, UsersController, RbacController, OrgController, FiscalController],
})
export class AdminModule {}
