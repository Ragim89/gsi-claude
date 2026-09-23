import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller';

/** Group-wide reference data: commodities (cultures) and ports. */
@Module({ controllers: [ReferenceController] })
export class ReferenceModule {}
