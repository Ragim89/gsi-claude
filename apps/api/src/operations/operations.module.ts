import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { JobsController, MediaController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ChecklistService } from './checklist.service';
import { JobWorkflowService } from './job-workflow.service';
import { JobEventsService } from './job-events.service';

/**
 * Operations domain: jobs, their lifecycle, the field checklist and its media
 * (docs/01-architecture.md, module 2; docs/WORKFLOWS.md).
 */
@Module({
  imports: [DocumentsModule],
  controllers: [JobsController, MediaController],
  providers: [JobsService, ChecklistService, JobWorkflowService, JobEventsService],
  exports: [JobsService, JobWorkflowService, JobEventsService],
})
export class OperationsModule {}
