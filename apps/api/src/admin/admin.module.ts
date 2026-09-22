import { Module } from '@nestjs/common';
import { BranchesController, UsersController } from './admin.controllers';

/** Admin domain: branches, users & roles (docs/01-architecture.md, module 11). */
@Module({ controllers: [BranchesController, UsersController] })
export class AdminModule {}
