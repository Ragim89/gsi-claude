import { Controller, Get, Query } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { SearchService } from './search.service';

class SearchQuery {
  @IsString() @MinLength(2) q!: string;
}

/** PHASE 10 — global search across jobs, clients, samples, reports/certificates and invoices. */
@Controller('search')
@RequirePermission('search.read')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(@CurrentUser() user: AuthUser, @Query() q: SearchQuery) {
    return this.search.search(user, q.q);
  }
}
