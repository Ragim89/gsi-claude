import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationEventsListener } from './notification-events.listener';
import { NotificationsCronService } from './notifications-cron.service';

/** PHASE 10 — notification centre: listens on the domain event bus (JobEventsService, global via CoreModule) and two clock-driven sweeps. */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEventsListener, NotificationsCronService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
