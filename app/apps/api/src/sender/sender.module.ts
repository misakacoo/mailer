import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ListsModule } from '../lists/lists.module';
import { TrackingModule } from '../tracking/tracking.module';
import { BounceService } from './bounce.service';
import { SchedulerService } from './scheduler.service';
import { SenderService } from './sender.service';

@Module({
  // 定时调度要复用 CampaignRunnerService，保证"到点自动发"和"手动开始"走同一条展开逻辑
  // ListsModule：硬退信时把地址移进「地址不存在」分组
  imports: [TrackingModule, CampaignsModule, ListsModule],
  providers: [SenderService, BounceService, SchedulerService],
  exports: [SenderService, BounceService, SchedulerService],
})
export class SenderModule {}
