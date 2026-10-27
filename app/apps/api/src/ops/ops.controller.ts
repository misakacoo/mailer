import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OpsService } from './ops.service';

@UseGuards(JwtAuthGuard)
@Controller('ops')
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('self-check')
  selfCheck() {
    return this.ops.selfCheck();
  }

  @Get('system')
  system() {
    return this.ops.systemInfo();
  }

  @Get('audit-logs')
  auditLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query('action') action?: string,
  ) {
    return this.ops.auditLogs({
      page: Math.max(page, 1),
      pageSize: Math.min(Math.max(pageSize, 1), 200),
      action: action?.trim() || undefined,
    });
  }

  /**
   * 清理审计日志。
   * beforeDays 为空表示全清；传 30 表示只删 30 天前的。
   * 清理动作本身会被审计拦截器记一条，所以"谁在什么时候清空了日志"仍留得住。
   */
  @Delete('audit-logs')
  clearAuditLogs(@Query('beforeDays') beforeDays?: string) {
    const days = beforeDays === undefined || beforeDays === '' ? undefined : Number(beforeDays);
    return this.ops.clearAuditLogs({
      beforeDays: Number.isFinite(days as number) ? (days as number) : undefined,
    });
  }

  @Post('mark-backup')
  markBackup(@Body() body: { at?: string }) {
    return this.ops.markBackup(body?.at);
  }
}
