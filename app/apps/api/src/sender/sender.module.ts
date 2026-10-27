import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { TrackingModule } from '../tracking/tracking.module';
import { BounceService } from './bounce.service';
import { SchedulerService } from './scheduler.service';
import { SenderService } from './sender.service';

@Module({
  // 定时调度要复用 CampaignRunnerService，保证"到点自动发"和"手动开始"走同一条展开逻辑
  imports: [TrackingModule, CampaignsModule],
  providers: [SenderService, BounceService, SchedulerService],
  exports: [SenderService, BounceService, SchedulerService],
})
export class SenderModule {}
