import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller';

/** CRM domain: clients / counterparties (docs/01-architecture.md, module 1). */
@Module({ controllers: [ClientsController] })
export class CrmModule {}
