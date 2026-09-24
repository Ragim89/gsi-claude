import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { InspectionsModule } from '../inspections/inspections.module';
import { SamplesController } from './samples.controller';
import { SamplesService } from './samples.service';
import { SampleWorkflowService } from './sample-workflow.service';
import { SampleMediaService } from './sample-media.service';

/**
 * Samples and chain of custody (docs/WORKFLOWS.md).
 *
 * Depends on Operations and Inspections rather than the other way round: a sample always
 * belongs to a job, usually to an inspection, and never the reverse.
 */
@Module({
  imports: [OperationsModule, InspectionsModule],
  controllers: [SamplesController],
  providers: [SamplesService, SampleWorkflowService, SampleMediaService],
  exports: [SamplesService],
})
export class SamplesModule {}
