import { Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { AnalyticsService } from './analytics.service';

class AnalyticsPeriodDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() countryId?: string;
}

/** PHASE 9 — Operational analytics: jobs, turnaround, workload. Read-only. */
@Controller('analytics')
@RequirePermission('analytics.read')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('jobs')
  jobs(@CurrentUser() user: AuthUser, @Query() q: AnalyticsPeriodDto) {
    return this.analytics.jobs(user, q.from, q.to, q.branchId, q.countryId);
  }

  @Get('turnaround')
  turnaround(@CurrentUser() user: AuthUser, @Query() q: AnalyticsPeriodDto) {
    return this.analytics.turnaround(user, q.from, q.to, q.branchId, q.countryId);
  }

  @Get('workload')
  @RequirePermission('analytics.workload')
  workload(@CurrentUser() user: AuthUser, @Query() q: AnalyticsPeriodDto) {
    return this.analytics.workload(user, q.from, q.to, q.branchId, q.countryId);
  }
}
