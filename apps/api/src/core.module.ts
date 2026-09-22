import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DbService } from './db/db.service';
import { StorageService } from './storage/storage.service';

/** Cross-cutting infrastructure shared by all domain modules. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [DbService, StorageService],
  exports: [DbService, StorageService, JwtModule],
})
export class CoreModule {}
