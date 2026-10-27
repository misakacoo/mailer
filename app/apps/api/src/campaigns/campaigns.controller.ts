import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CampaignsService } from './campaigns.service';
import {
  CreateCampaignDto,
  QueryRecipientsDto,
  ScheduleCampaignDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

@UseGuards(JwtAuthGuard)
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  /** 分组人数与可投递人数：向导里如实展示，避免"显示 2 人只发 1 封" */
  @Get('audience')
  audience(@Query('listIds') listIds?: string) {
    const ids = String(listIds ?? '')
      .split(',')
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0);
    return this.campaigns.audienceInfo(ids);
  }

  /** deleted=1 查回收站 */
  @Get()
  list(@Query('deleted') deleted?: string) {
    return this.campaigns.list(deleted === '1');
  }

  /** 从回收站恢复 */
  @Post(':id/restore')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.restore(id);
  }

  /** 彻底删除（仅限已在回收站里的任务） */
  @Post(':id/purge')
  purge(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.purge(id);
  }

  /** 停止整个周期序列 */
  @Post(':id/stop-series')
  stopSeries(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.stopSeries(id);
  }

  @Post()
  create(@Body() dto: CreateCampaignDto) {
    return this.campaigns.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.remove(id);
  }

  @Post(':id/start')
  start(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.start(id);
  }

  /** 排期到未来某个时间点，到点由 worker 自动启动 */
  @Post(':id/schedule')
  schedule(@Param('id', ParseIntPipe) id: number, @Body() dto: ScheduleCampaignDto) {
    return this.campaigns.schedule(id, dto.scheduledAt);
  }

  @Post(':id/unschedule')
  unschedule(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.unschedule(id);
  }

  @Post(':id/pause')
  pause(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.resume(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.cancel(id);
  }

  @Get(':id/recipients')
  recipients(@Param('id', ParseIntPipe) id: number, @Query() q: QueryRecipientsDto) {
    return this.campaigns.recipients(id, q);
  }
}
