import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive,
  IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { AuthUser, QUOTE_STATUSES, QuoteStatus } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { QuotesService } from './quotes.service';

class QuoteLineDto {
  @IsOptional() @IsUUID() serviceId?: string | null;
  @IsString() @MinLength(2) @MaxLength(300) description: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  @Type(() => Number) @IsNumber() @Min(0) unitPrice: number;
}

class CreateQuoteDto {
  @IsUUID() clientId: string;
  @IsOptional() @IsUUID() jobId?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => QuoteLineDto)
  lines: QuoteLineDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() validUntil?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(3) currency?: string;
}

class QuoteQueryDto {
  @IsOptional() @IsIn(QUOTE_STATUSES) status?: QuoteStatus;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

class QuoteActionDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
}

/** Quotes (PHASE 8): the commercial offer that precedes an invoice. */
@Controller('finance/quotes')
@RequirePermission('quote.read')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: QuoteQueryDto) {
    return this.quotes.list(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.get(user, id);
  }

  @Post()
  @RequirePermission('quote.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateQuoteDto) {
    return this.quotes.create(user, dto);
  }

  @Delete(':id')
  @RequirePermission('quote.update')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.quotes.remove(user, id);
  }

  @Post(':id/create-invoice')
  @RequirePermission('invoice.create')
  @HttpCode(201)
  createInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.createInvoice(user, id);
  }

  // One route per workflow action, same shape as jobs/reports (see e.g. reports.controller.ts).
  @Post(':id/send')
  @RequirePermission('quote.send')
  @HttpCode(200)
  send(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.transition(user, id, 'send');
  }

  @Post(':id/accept')
  @RequirePermission('quote.decide')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.transition(user, id, 'accept');
  }

  @Post(':id/reject')
  @RequirePermission('quote.decide')
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteActionDto) {
    return this.quotes.transition(user, id, 'reject', dto.reason);
  }

  @Post(':id/expire')
  @RequirePermission('quote.decide')
  @HttpCode(200)
  expire(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.transition(user, id, 'expire');
  }

  @Post(':id/revise')
  @RequirePermission('quote.update')
  @HttpCode(200)
  revise(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteActionDto) {
    return this.quotes.transition(user, id, 'revise', dto.reason);
  }

  @Post(':id/cancel')
  @RequirePermission('quote.cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteActionDto) {
    return this.quotes.transition(user, id, 'cancel', dto.reason);
  }
}
