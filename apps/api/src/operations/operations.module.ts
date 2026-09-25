import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { JobsController, MediaController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ChecklistService } from './checklist.service';
import { JobWorkflowService } from './job-workflow.service';

/**
 * Operations domain: jobs, their lifecycle, the field checklist and its media
 * (docs/01-architecture.md, module 2; docs/WORKFLOWS.md).
 *
 * `JobEventsService` (the domain event bus) now lives in CoreModule — see the comment there —
 * so it is neither provided nor exported here, only used.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [JobsController, MediaController],
  providers: [JobsService, ChecklistService, JobWorkflowService],
  exports: [JobsService, JobWorkflowService],
})
export class OperationsModule {}
