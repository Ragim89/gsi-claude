import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthUser, DOCUMENT_CATEGORIES, DOCUMENT_ENTITY_TYPES, DOCUMENT_VISIBILITIES, DocumentCategory, DocumentEntityType, DocumentVisibility } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { DocumentRegistryService } from './document-registry.service';

class ListDocumentsQuery {
  @IsIn(DOCUMENT_ENTITY_TYPES) entityType!: DocumentEntityType;
  @IsUUID() entityId!: string;
}

class UploadDocumentDto {
  @IsIn(DOCUMENT_ENTITY_TYPES) entityType!: DocumentEntityType;
  @IsUUID() entityId!: string;
  @IsIn(DOCUMENT_CATEGORIES) category!: DocumentCategory;
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsIn(DOCUMENT_VISIBILITIES) visibility?: DocumentVisibility;
  @IsOptional() @IsUUID() replacesId?: string;
}

class ArchiveDocumentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** PHASE 10 — general documents registry: client/job/inspection/sample/report/invoice attachments. */
@Controller('documents')
export class DocumentRegistryController {
  constructor(private readonly documents: DocumentRegistryService) {}

  @Get()
  @RequirePermission('document.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListDocumentsQuery) {
    return this.documents.list(user, q.entityType, q.entityId);
  }

  @Post()
  @RequirePermission('document.upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @Body() body: UploadDocumentDto, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('File is required');
    return this.documents.upload(user, file, body);
  }

  @Post(':id/archive')
  @RequirePermission('document.archive')
  archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ArchiveDocumentDto) {
    return this.documents.archive(user, id, body.reason).then(() => ({ ok: true }));
  }
}
