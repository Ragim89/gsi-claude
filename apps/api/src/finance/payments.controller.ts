import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsPositive,
  IsString, IsUUID, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { AuthUser, PAYMENT_DIRECTIONS, PAYMENT_METHODS, PaymentDirection, PaymentMethod } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { PaymentsService } from './payments.service';

class AllocationDto {
  @IsOptional() @IsUUID() invoiceId?: string;
  @IsOptional() @IsUUID() expenseId?: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
}

class CreatePaymentDto {
  @IsUUID() branchId: string;
  @IsIn(PAYMENT_DIRECTIONS) direction: PaymentDirection;
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) supplier?: string | null;
  @IsOptional() @IsIn(PAYMENT_METHODS) method?: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(200) reference?: string | null;
  @IsString() @MinLength(3) @MaxLength(3) currency: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsDateString() paymentDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

class AllocateDto {
  @IsOptional() @IsUUID() invoiceId?: string;
  @IsOptional() @IsUUID() expenseId?: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
}

class PaymentQueryDto {
  @IsOptional() @IsIn(PAYMENT_DIRECTIONS) direction?: PaymentDirection;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

/**
 * Payments as their own entity (PHASE 8): see payments.service.ts for the accounting shape.
 *
 * Creating one requires `payment.create` for an inbound (client) payment or `expense.pay` for
 * an outbound (accounts-payable) one — checked here rather than by decorator, since the
 * direction is only known once the body has been parsed.
 */
@Controller('finance/payments')
@RequirePermission('payment.read')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PaymentQueryDto) {
    return this.payments.list(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user, id);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    const required = dto.direction === 'inbound' ? 'payment.create' : 'expense.pay';
    if (!user.permissions?.includes(required)) {
      throw new ForbiddenException(`Requires permission: ${required}`);
    }
    if (dto.direction === 'outbound' && !dto.supplier) {
      throw new BadRequestException('An outbound payment needs a supplier');
    }
    return this.payments.createStandalone(user, dto);
  }

  @Post(':id/allocate')
  @RequirePermission('payment.allocate')
  @HttpCode(200)
  allocate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocateDto) {
    return this.payments.allocate(user, id, { invoiceId: dto.invoiceId, expenseId: dto.expenseId }, dto.amount);
  }
}
