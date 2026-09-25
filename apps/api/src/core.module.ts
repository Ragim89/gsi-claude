import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DbService } from './db/db.service';
import { StorageService } from './storage/storage.service';
import { RbacService } from './auth/rbac.service';
import { AuditService } from './common/audit.service';
import { JobEventsService } from './operations/job-events.service';

/**
 * Cross-cutting infrastructure shared by all domain modules.
 *
 * `JobEventsService` lives here rather than in OperationsModule (its original home) because
 * DocumentsModule now emits through it too (report-workflow.service.ts), and OperationsModule
 * already imports DocumentsModule for the job report preview — a cycle a global provider avoids
 * rather than papering over with `forwardRef`.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [DbService, StorageService, RbacService, AuditService, JobEventsService],
  exports: [DbService, StorageService, RbacService, AuditService, JwtModule, JobEventsService],
})
export class CoreModule {}
