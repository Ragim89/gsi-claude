import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { LaboratoryController } from './laboratory.controller';
import { LabCatalogueService } from './lab-catalogue.service';
import { LabRequestsService } from './lab-requests.service';
import { LabResultsService } from './lab-results.service';
import { LabWorkflowService } from './lab-workflow.service';
import { LabMediaService } from './lab-media.service';

/**
 * Laboratory information management (docs/WORKFLOWS.md).
 *
 * It depends on Operations only for the event bus. Samples are read by id rather than through
 * SamplesModule: the laboratory needs to know that a sample was accepted, not how it got there,
 * and keeping the dependency one-way leaves PHASE 5 free of any knowledge of PHASE 6.
 */
@Module({
  imports: [OperationsModule],
  controllers: [LaboratoryController],
  providers: [LabCatalogueService, LabRequestsService, LabResultsService, LabWorkflowService, LabMediaService],
  exports: [LabResultsService, LabRequestsService],
})
export class LaboratoryModule {}
