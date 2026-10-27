import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 无需登录：给 Nginx / 监控 / 部署脚本用 */
  @Get()
  async check() {
    const started = Date.now();
    let db: 'ok' | 'down' = 'down';
    let error: string | null = null;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'ok';
    } catch (e: any) {
      error = e?.message ?? String(e);
    }

    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      dbLatencyMs: Date.now() - started,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      time: new Date().toISOString(),
      error,
    };
  }
}
