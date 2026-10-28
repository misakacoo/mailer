import {
  BadRequestException,
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
      // 上限 1 万页：再往后是纯 OFFSET 扫描，没有意义
      page: Math.min(Math.max(page, 1), 10_000),
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
  clearAuditLogs(
    @Query('beforeDays', new DefaultValuePipe(0), ParseIntPipe) beforeDays: number,
    @Query('currentPassword') currentPassword: string,
    @Query('all') all?: string,
  ) {
    // 参数必须是明确的正整数：以前传 abc 会被当成 undefined → 整表清空
    if (!Number.isInteger(beforeDays) || beforeDays < 1) {
      throw new BadRequestException('请指定要清理多少天之前的日志（beforeDays ≥ 1）');
    }
    return this.ops.clearAuditLogs({
      beforeDays,
      currentPassword,
      all: all === '1' || all === 'true',
    });
  }

  @Post('mark-backup')
  markBackup(@Body() body: { at?: string }) {
    return this.ops.markBackup(body?.at);
  }
}
