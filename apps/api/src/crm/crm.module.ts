import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller';
import { ClientContactsController } from './contacts.controller';
import { ContractsController } from './contracts.controller';

/**
 * CRM domain: clients, the people at them, and the contracts their work is performed under
 * (docs/01-architecture.md, module 1).
 */
@Module({ controllers: [ClientsController, ClientContactsController, ContractsController] })
export class CrmModule {}
