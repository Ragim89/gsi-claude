import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** PHASE 10 — global search. Reads existing tables under existing RLS; no schema of its own. */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
