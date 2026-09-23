import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ExportService } from './export.service';
import type { CsvDialect } from './csv';

class ExportQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() commodityId?: string;
  @IsOptional() @IsUUID() portId?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(5) locale?: string;
  /** semicolon (Excel in TR/RU/EU locales, decimal comma) or comma (CSV standard). */
  @IsOptional() @IsIn(['semicolon', 'comma']) sep?: CsvDialect;
}

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * Data export. Anything on screen can leave the system as a spreadsheet: one section as CSV,
 * or every section the user may see as a single ZIP. Row-Level Security applies exactly as it
 * does in the app, so an export never widens what someone can reach.
 */
@RequirePermission('export.run')
@Controller('export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  /** Which sections this user is allowed to export (drives the UI). */
  @Get('sections')
  sections(@CurrentUser() user: AuthUser) {
    return { sections: this.exportService.sectionNames(user) };
  }

  @Get('all')
  async all(@CurrentUser() user: AuthUser, @Query() q: ExportQueryDto) {
    const files = await this.exportService.allSections(user, q, q.sep ?? 'semicolon');

    const archive = archiver('zip', { zlib: { level: 9 } });
    const out = new PassThrough();
    archive.pipe(out);
    for (const f of files) archive.append(Buffer.from(f.csv, 'utf8'), { name: `${f.name}.csv` });
    // Errors surface on the stream; the client sees a truncated download rather than a hang.
    archive.on('error', (err) => out.destroy(err));
    void archive.finalize();

    return new StreamableFile(out, {
      type: 'application/zip',
      disposition: `attachment; filename="gsi-export-${stamp()}.zip"`,
    });
  }

  @Get(':section')
  async section(
    @CurrentUser() user: AuthUser,
    @Param('section') section: string,
    @Query() q: ExportQueryDto,
  ) {
    const csv = await this.exportService.csv(user, section, q, q.sep ?? 'semicolon');
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="gsi-${section}-${stamp()}.csv"`,
    });
  }
}
