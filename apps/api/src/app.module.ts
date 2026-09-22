import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CoreModule } from './core.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CrmModule } from './crm/crm.module';
import { OperationsModule } from './operations/operations.module';
import { DocumentsModule } from './documents/documents.module';
import { AuthGuard } from './common/auth.guard';
import { PgExceptionFilter } from './common/pg-exception.filter';
import { Public } from './common/decorators';
import { DbService } from './db/db.service';

@Controller('health')
class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async health() {
    await this.db.tx(null, (tx) => tx.one('SELECT 1'));
    return { status: 'ok' };
  }
}

/**
 * Modular monolith (docs/05-tech-stack.md): one module per domain.
 * Lab (LIMS), Finance, HR and Compliance modules plug in here in later milestones.
 */
@Module({
  imports: [CoreModule, AuthModule, AdminModule, CrmModule, OperationsModule, DocumentsModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: PgExceptionFilter },
  ],
})
export class AppModule {}
