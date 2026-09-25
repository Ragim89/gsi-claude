import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString,
  IsUUID, Min, MaxLength, MinLength,
} from 'class-validator';
import { AuthUser, SERVICE_TYPES, ServiceType } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ServicesPricingService } from './services-pricing.service';

class CreateServiceDto {
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsObject() name: Record<string, string>;
  @IsOptional() @IsIn(SERVICE_TYPES) serviceType?: ServiceType | null;
  @IsOptional() @IsString() @MaxLength(40) unit?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

class UpdateServiceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) code?: string;
  @IsOptional() @IsObject() name?: Record<string, string>;
  @IsOptional() @IsIn(SERVICE_TYPES) serviceType?: ServiceType | null;
  @IsOptional() @IsString() @MaxLength(40) unit?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CreatePriceDto {
  @IsUUID() serviceId: string;
  @IsUUID() branchId: string;
  @IsOptional() @IsUUID() contractId?: string | null;
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsString() @MinLength(3) @MaxLength(3) currency: string;
  @Type(() => Number) @IsNumber() @Min(0) unitPrice: number;
  @IsOptional() @IsDateString() effectiveFrom?: string;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

class PriceQueryDto {
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() clientId?: string;
}

class ResolvePriceQueryDto {
  @IsUUID() serviceId: string;
  @IsUUID() branchId: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @IsDateString() on?: string;
}

/** The service catalogue and its price list (PHASE 8). */
@Controller('finance')
export class PricingController {
  constructor(private readonly pricing: ServicesPricingService) {}

  @Get('services')
  @RequirePermission('service.read')
  listServices(@CurrentUser() user: AuthUser, @Query('activeOnly') activeOnly?: string) {
    return this.pricing.listServices(user, activeOnly !== 'false');
  }

  @Post('services')
  @RequirePermission('service.manage')
  createService(@CurrentUser() user: AuthUser, @Body() dto: CreateServiceDto) {
    return this.pricing.createService(user, dto);
  }

  @Patch('services/:id')
  @RequirePermission('service.manage')
  updateService(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceDto) {
    return this.pricing.updateService(user, id, dto);
  }

  @Get('prices')
  @RequirePermission('pricing.read')
  listPrices(@CurrentUser() user: AuthUser, @Query() q: PriceQueryDto) {
    return this.pricing.listPrices(user, q);
  }

  @Post('prices')
  @RequirePermission('pricing.manage')
  createPrice(@CurrentUser() user: AuthUser, @Body() dto: CreatePriceDto) {
    return this.pricing.createPrice(user, dto);
  }

  @Patch('prices/:id/deactivate')
  @RequirePermission('pricing.manage')
  deactivatePrice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.deactivatePrice(user, id);
  }

  /** What a service costs right now, for pre-filling a quote line. */
  @Get('prices/resolve')
  @RequirePermission('pricing.read')
  resolve(@CurrentUser() user: AuthUser, @Query() q: ResolvePriceQueryDto) {
    return this.pricing.resolve(user, q.serviceId, q.branchId, q.clientId, q.contractId, q.on);
  }
}
