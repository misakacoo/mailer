import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelGroupsController } from './channel-groups.controller';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [AuthModule],
  controllers: [ChannelsController, ChannelGroupsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
