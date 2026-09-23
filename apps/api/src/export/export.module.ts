import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

/** Spreadsheet export for every section the user can see. */
@Module({ controllers: [ExportController], providers: [ExportService] })
export class ExportModule {}
