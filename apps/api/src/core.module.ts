import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DbService } from './db/db.service';
import { StorageService } from './storage/storage.service';
import { RbacService } from './auth/rbac.service';
import { AuditService } from './common/audit.service';

/** Cross-cutting infrastructure shared by all domain modules. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [DbService, StorageService, RbacService, AuditService],
  exports: [DbService, StorageService, RbacService, AuditService, JwtModule],
})
export class CoreModule {}
