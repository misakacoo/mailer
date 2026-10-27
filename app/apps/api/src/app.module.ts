import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ChannelsModule } from './channels/channels.module';
import { AppConfigModule } from './common/config.module';
import { PrismaModule } from './common/prisma.module';
import { ContactsModule } from './contacts/contacts.module';
import { HealthModule } from './health/health.module';
import { ListsModule } from './lists/lists.module';
import { MailModule } from './mail/mail.module';
import { OpsModule } from './ops/ops.module';
import { SenderModule } from './sender/sender.module';
import { StatsModule } from './stats/stats.module';
import { TemplatesModule } from './templates/templates.module';
import { TrackingModule } from './tracking/tracking.module';
import { AuditInterceptor } from './common/audit.interceptor';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    MailModule,
    AuthModule,
    HealthModule,
    ChannelsModule,
    ListsModule,
    ContactsModule,
    TemplatesModule,
    CampaignsModule,
    SenderModule,
    TrackingModule,
    StatsModule,
    OpsModule,
  ],
  providers: [AuditInterceptor],
})
export class AppModule {}
