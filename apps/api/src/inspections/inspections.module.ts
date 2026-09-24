import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';
import { InspectionFieldService } from './inspection-field.service';
import { InspectionWorkflowService } from './inspection-workflow.service';

/**
 * Inspections: the field work of a job (docs/01-architecture.md, module 3; docs/WORKFLOWS.md).
 *
 * It depends on Operations rather than the other way round — an inspection always belongs to
 * a job, and the job's own status is moved only by JobWorkflowService.
 */
@Module({
  imports: [OperationsModule],
  controllers: [InspectionsController],
  providers: [InspectionsService, InspectionFieldService, InspectionWorkflowService],
  exports: [InspectionsService, InspectionWorkflowService],
})
export class InspectionsModule {}
