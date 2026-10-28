import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { StatsService } from './stats.service';

@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  overview() {
    return this.stats.overview();
  }

  @Get('trend')
  trend(@Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number) {
    return this.stats.trend(Math.min(Math.max(days, 1), 90));
  }

  @Get('channels')
  channels(@Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number) {
    return this.stats.byChannel(Math.min(Math.max(days, 1), 365));
  }

  @Get('campaigns')
  campaigns(@Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return this.stats.byCampaign(Math.min(Math.max(limit, 1), 100));
  }

  @Get('failures')
  failures(@Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number) {
    return this.stats.failures(Math.min(Math.max(days, 1), 365));
  }
}
