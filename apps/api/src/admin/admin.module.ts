import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { UsersController } from './admin.controllers';
import { RbacController } from './rbac.controller';
import { OrgController } from './org.controller';

/**
 * Admin domain: the shape of the group (organisation, countries, offices, departments),
 * its people, who may do what, and the audit trail — docs/01-architecture.md, module 11.
 */
@Module({ controllers: [BranchesController, UsersController, RbacController, OrgController] })
export class AdminModule {}
