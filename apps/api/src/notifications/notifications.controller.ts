import { Controller, Get, MessageEvent, Param, ParseUUIDPipe, Post, Query, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { NotificationsService } from './notifications.service';

class ListNotificationsQuery {
  @IsOptional() @Type(() => Boolean) @IsBoolean() unreadOnly?: boolean;
}

/** PHASE 10 — each user's own notification centre; see notifications.service.ts for the RLS story. */
@Controller('notifications')
@RequirePermission('notification.read')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListNotificationsQuery) {
    return this.notifications.list(user, q.unreadOnly ?? false);
  }

  @Post(':id/read')
  async markRead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(user, id);
    return { ok: true };
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user);
    return { ok: true };
  }

  /** EventSource cannot send an Authorization header, so the web client reads this via fetch — see api.ts. */
  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return this.notifications.stream(user.id).pipe(map((data) => ({ data }) as MessageEvent));
  }
}
