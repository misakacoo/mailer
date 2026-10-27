import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [AuthModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignRunnerService],
  // runner 要给 worker 里的定时调度器用，两边共用同一份展开逻辑
  exports: [CampaignsService, CampaignRunnerService],
})
export class CampaignsModule {}
