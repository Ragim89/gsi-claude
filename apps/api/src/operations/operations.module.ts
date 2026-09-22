import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { JobsController, MediaController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ChecklistService } from './checklist.service';

/** Operations domain: jobs, field checklist, media (docs/01-architecture.md, module 2). */
@Module({
  imports: [DocumentsModule],
  controllers: [JobsController, MediaController],
  providers: [JobsService, ChecklistService],
})
export class OperationsModule {}
