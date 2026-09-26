import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  IsBoolean, IsDateString, IsObject, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength,
} from 'class-validator';
import { JurisdictionProfileConfig } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { AuthUser } from '@gsi/shared-types';
import { LegalEntityService } from '../finance/legal-entity.service';
import { JurisdictionProfileService } from '../finance/jurisdiction-profile.service';

class LegalEntityDto {
  @IsUUID() countryId: string;
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) legalName: string;
  @IsOptional() @IsString() @MaxLength(500) legalAddress?: string | null;
  @IsOptional() @IsString() @MaxLength(20) fiscalIdentifierType?: string | null;
  @IsOptional() @IsString() @MaxLength(60) fiscalIdentifier?: string | null;
  @IsOptional() @IsBoolean() vatRegistered?: boolean;
  @IsOptional() @IsString() @MaxLength(60) vatRegistrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultTaxCode?: string | null;
  /** Optional — defaults from the country's verified jurisdiction profile (e.g. KZT for KZ)
   *  when omitted; required only for a country with none configured yet. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(3) defaultCurrency?: string;
  @IsOptional() @IsString() @MaxLength(200) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(60) bankAccount?: string | null;
  @IsOptional() @IsString() @MaxLength(20) bankSwift?: string | null;
  @IsOptional() @IsString() @MaxLength(10) invoiceNumberPrefix?: string | null;
}

class UpdateLegalEntityDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) legalName?: string;
  @IsOptional() @IsString() @MaxLength(500) legalAddress?: string | null;
  @IsOptional() @IsString() @MaxLength(20) fiscalIdentifierType?: string | null;
  @IsOptional() @IsString() @MaxLength(60) fiscalIdentifier?: string | null;
  @IsOptional() @IsBoolean() vatRegistered?: boolean;
  @IsOptional() @IsString() @MaxLength(60) vatRegistrationNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultTaxCode?: string | null;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(3) defaultCurrency?: string;
  @IsOptional() @IsString() @MaxLength(200) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(60) bankAccount?: string | null;
  @IsOptional() @IsString() @MaxLength(20) bankSwift?: string | null;
  @IsOptional() @IsString() @MaxLength(10) invoiceNumberPrefix?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class JurisdictionProfileDto {
  @IsString() @Length(2, 2) countryCode: string;
  @IsDateString() effectiveFrom: string;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsString() @Length(3, 3) defaultDocumentCurrency: string;
  @IsObject() config: JurisdictionProfileConfig;
  @IsOptional() @IsString() @MaxLength(4000) sourceNotes?: string | null;
}

/**
 * Finance / Fiscal Configuration (docs/FISCAL_COMPLIANCE.md). Reading is available to anyone
 * who sees financial data at all (`finance.read`) — an invoice-creation screen needs to list
 * legal entities to pick from; changing one is `legal_entity.manage` / `fiscal_profile.manage`,
 * granted to admin only (migration 028) so an ordinary finance/inspector/lab role cannot touch
 * jurisdiction rules, per the task's explicit requirement.
 */
@Controller('admin/fiscal')
@RequirePermission('finance.read')
export class FiscalController {
  constructor(
    private readonly legalEntities: LegalEntityService,
    private readonly profiles: JurisdictionProfileService,
  ) {}

  @Get('legal-entities')
  listLegalEntities(
    @CurrentUser() user: AuthUser,
    @Query('includeInactive') includeInactive?: string,
    @Query('countryId') countryId?: string,
  ) {
    return this.legalEntities.list(user, { includeInactive: includeInactive === 'true', countryId });
  }

  @Get('legal-entities/:id')
  getLegalEntity(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.legalEntities.get(user, id);
  }

  @Post('legal-entities')
  @RequirePermission('legal_entity.manage')
  createLegalEntity(@CurrentUser() user: AuthUser, @Body() dto: LegalEntityDto) {
    return this.legalEntities.create(user, dto);
  }

  @Patch('legal-entities/:id')
  @RequirePermission('legal_entity.manage')
  updateLegalEntity(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLegalEntityDto,
  ) {
    return this.legalEntities.update(user, id, dto);
  }

  @Get('jurisdiction-profiles')
  listProfiles(@CurrentUser() user: AuthUser, @Query('countryCode') countryCode?: string) {
    return this.profiles.list(user, countryCode);
  }

  @Get('jurisdiction-countries')
  countries(@CurrentUser() user: AuthUser) {
    return this.profiles.countries(user);
  }

  /** Adds the NEXT version for a country. Never edits an existing one — see JurisdictionProfileService. */
  @Post('jurisdiction-profiles')
  @RequirePermission('fiscal_profile.manage')
  createProfileVersion(@CurrentUser() user: AuthUser, @Body() dto: JurisdictionProfileDto) {
    return this.profiles.createVersion(user, dto);
  }
}
