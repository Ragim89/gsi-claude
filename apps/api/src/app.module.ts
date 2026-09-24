import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CrmModule } from './crm/crm.module';
import { OperationsModule } from './operations/operations.module';
import { InspectionsModule } from './inspections/inspections.module';
import { SamplesModule } from './samples/samples.module';
import { LaboratoryModule } from './laboratory/laboratory.module';
import { DocumentsModule } from './documents/documents.module';
import { FinanceModule } from './finance/finance.module';
import { ReferenceModule } from './reference/reference.module';
import { AssetsModule } from './assets/assets.module';
import { ExportModule } from './export/export.module';
import { ImportModule } from './import/import.module';
import { HealthModule } from './health/health.controller';
import { AuthGuard } from './common/auth.guard';
import { GsiThrottlerGuard } from './common/throttler.guard';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestContext } from './common/request-context';
import { config } from './config';

/**
 * Modular monolith (docs/05-tech-stack.md): one module per domain.
 * Lab (LIMS), HR and Compliance modules plug in here in later phases —
 * see docs/IMPLEMENTATION_PLAN.md.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: config.rateLimit.windowSeconds * 1000, limit: config.rateLimit.limit },
    ]),
    CoreModule,
    HealthModule,
    AuthModule,
    AdminModule,
    CrmModule,
    OperationsModule,
    InspectionsModule,
    SamplesModule,
    LaboratoryModule,
    DocumentsModule,
    FinanceModule,
    ReferenceModule,
    AssetsModule,
    ExportModule,
    ImportModule,
  ],
  providers: [
    // Order matters: rate limiting runs before authentication, so a flood of invalid
    // tokens is cut off before it reaches the database.
    { provide: APP_GUARD, useClass: GsiThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContext).forRoutes('*');
  }
}
