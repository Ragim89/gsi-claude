import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional } from 'class-validator';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ImportService } from './import.service';
import { parseFile } from './parse';
import type { CsvDialect } from '../export/csv';

class TemplateQueryDto {
  @IsOptional() @IsIn(['semicolon', 'comma']) sep?: CsvDialect;
}

/** Uploaded file as multer hands it over (memory storage). */
interface UploadedSpreadsheet {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const MAX_UPLOAD = 10 * 1024 * 1024;
const upload = () =>
  UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }));

/**
 * Bulk load from Excel/CSV. The flow is deliberately three calls:
 *   GET  /import/:section/template  — a pre-filled file to fill in
 *   POST /import/:section/preview   — validates every row, changes nothing
 *   POST /import/:section           — writes, in one transaction
 * The same file is uploaded twice (preview, then commit) so nothing is held server-side
 * between the two steps and the user can edit and re-check as often as they like.
 */
@RequirePermission('import.run')
@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Get('sections')
  sections(@CurrentUser() user: AuthUser) {
    return { sections: this.importService.sectionNames(user) };
  }

  @Get(':section/template')
  template(
    @CurrentUser() user: AuthUser,
    @Param('section') section: string,
    @Query() q: TemplateQueryDto,
  ) {
    const csv = this.importService.template(user, section, q.sep ?? 'semicolon');
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="gsi-import-${section}-template.csv"`,
    });
  }

  @Post(':section/preview')
  @upload()
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('section') section: string,
    @UploadedFile() file?: UploadedSpreadsheet,
  ) {
    const { rows, headers } = await this.read(file);
    return this.importService.preview(user, section, rows, headers);
  }

  @Post(':section')
  @upload()
  async commit(
    @CurrentUser() user: AuthUser,
    @Param('section') section: string,
    @UploadedFile() file?: UploadedSpreadsheet,
  ) {
    const { rows, headers } = await this.read(file);
    return this.importService.commit(user, section, rows, headers);
  }

  private async read(file?: UploadedSpreadsheet) {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
    try {
      return await parseFile(file);
    } catch {
      throw new BadRequestException('Could not read the file — expected .xlsx or .csv');
    }
  }
}
