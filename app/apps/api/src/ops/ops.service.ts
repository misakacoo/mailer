import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';
import { calendarDay } from '../common/quota';
import { log } from '../common/logger';
import { isSameCalendarDay } from '../common/quota';

/** 只用于展示的日期格式，不参与任何计算 */
function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** 便于前端做进度条/标签的原始值 */
  value?: string;
}

export const HEARTBEAT_KEY = 'worker_heartbeat';
export const BACKUP_KEY = 'last_backup_at';

@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * 系统自检。
   *
   * 这些检查的意义不在于"能跑"，而在于提前发现会在半夜出问题的地方：
   * 证书 6 天到期、磁盘写满、worker 悄悄死掉、备份停在三天前。
   * 每一项都必须给出"怎么办"，而不只是"有问题"。
   */
  async selfCheck(): Promise<{ checks: Check[]; ok: boolean; generatedAt: string }> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkWorker(),
      this.checkDisk(),
      this.checkCertificate(),
      this.checkBackup(),
      this.checkQueue(),
    ]);

    const ok = !checks.some((c) => c.status === 'error');
    return { checks, ok, generatedAt: new Date().toISOString() };
  }

  private async checkDatabase(): Promise<Check> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const ms = Date.now() - started;
      return {
        key: 'database',
        label: '数据库',
        status: ms > 200 ? 'warn' : 'ok',
        detail: `查询耗时 ${ms}ms`,
        value: `${ms}ms`,
      };
    } catch (e: any) {
      return {
        key: 'database',
        label: '数据库',
        status: 'error',
        detail: `连接失败：${e?.message ?? String(e)}`,
      };
    }
  }

  private async checkWorker(): Promise<Check> {
    const row = await this.prisma.systemState.findUnique({ where: { key: HEARTBEAT_KEY } });
    if (!row) {
      return {
        key: 'worker',
        label: '发送进程',
        status: 'warn',
        detail: '尚未收到心跳，如果刚启动请等 30 秒',
      };
    }
    const ageSec = Math.round((Date.now() - row.updatedAt.getTime()) / 1000);
    if (ageSec > 180) {
      return {
        key: 'worker',
        label: '发送进程',
        status: 'error',
        detail: `心跳已停止 ${ageSec} 秒，发送队列不会推进`,
        value: `${ageSec}s`,
      };
    }
    if (ageSec > 90) {
      return {
        key: 'worker',
        label: '发送进程',
        status: 'warn',
        detail: `心跳延迟 ${ageSec} 秒，可能正在发信或网络抖动`,
        value: `${ageSec}s`,
      };
    }
    return {
      key: 'worker',
      label: '发送进程',
      status: 'ok',
      detail: `${ageSec} 秒前有心跳`,
      value: `${ageSec}s`,
    };
  }

  private async checkDisk(): Promise<Check> {
    try {
      const st = fs.statfsSync('/');
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const usedPct = total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0;
      const freeGb = Math.round((free / 1024 ** 3) * 10) / 10;
      const status: CheckStatus = usedPct >= 90 ? 'error' : usedPct >= 80 ? 'warn' : 'ok';
      return {
        key: 'disk',
        label: '磁盘',
        status,
        detail: `已用 ${usedPct}%，剩余 ${freeGb} GB`,
        value: `${usedPct}%`,
      };
    } catch (e: any) {
      return {
        key: 'disk',
        label: '磁盘',
        status: 'warn',
        detail: `无法读取磁盘信息：${e?.message ?? String(e)}`,
      };
    }
  }

  private async checkCertificate(): Promise<Check> {
    const p = this.cfg.tlsCertPath;
    if (!p) {
      return {
        key: 'cert',
        label: 'HTTPS 证书',
        status: 'skip',
        detail: '未配置 TLS_CERT_PATH，跳过',
      };
    }
    try {
      const pem = fs.readFileSync(p, 'utf8');
      const cert = new X509Certificate(pem);
      const expires = new Date(cert.validTo);
      const days = Math.floor((expires.getTime() - Date.now()) / 86400000);
      const renewalHint = '证书由 certbot 定时续期，如持续减少请检查 cron 与 /var/log/letsencrypt';
      if (days < 0) {
        return {
          key: 'cert',
          label: 'HTTPS 证书',
          status: 'error',
          detail: `证书已于 ${fmtDate(expires)} 过期`,
          value: `${days}d`,
        };
      }
      if (days <= 2) {
        return {
          key: 'cert',
          label: 'HTTPS 证书',
          status: 'error',
          detail: `${days} 天后过期（${fmtDate(expires)}）。${renewalHint}`,
          value: `${days}d`,
        };
      }
      if (days <= 4) {
        return {
          key: 'cert',
          label: 'HTTPS 证书',
          status: 'warn',
          detail: `${days} 天后过期（${fmtDate(expires)}）。${renewalHint}`,
          value: `${days}d`,
        };
      }
      return {
        key: 'cert',
        label: 'HTTPS 证书',
        status: 'ok',
        detail: `有效期至 ${fmtDate(expires)}（${days} 天）`,
        value: `${days}d`,
      };
    } catch (e: any) {
      return {
        key: 'cert',
        label: 'HTTPS 证书',
        status: 'warn',
        detail: `读取证书失败：${e?.message ?? String(e)}`,
      };
    }
  }

  /**
   * 备份检查优先看备份脚本自己写的心跳，因为它能区分"备份成功"和"目录还活着但 cron 没跑"。
   * 没有心跳时退回到看目录里最新文件的修改时间。
   */
  private async checkBackup(): Promise<Check> {
    const dir = this.cfg.backupDir;
    if (!dir) {
      return {
        key: 'backup',
        label: '数据备份',
        status: 'skip',
        detail: '未配置 BACKUP_DIR，跳过',
      };
    }

    const heartbeat = await this.prisma.systemState.findUnique({ where: { key: BACKUP_KEY } });
    let latestAt: Date | null = heartbeat ? new Date(heartbeat.value) : null;
    let sizeMb: number | null = null;

    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.dump') || f.endsWith('.tar.gz') || f.endsWith('.gz'))
        .map((f) => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          return { name: f, mtime: st.mtime, size: st.size };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      if (files.length > 0) {
        if (!latestAt || files[0].mtime > latestAt) latestAt = files[0].mtime;
        sizeMb = Math.round((files[0].size / 1024 / 1024) * 10) / 10;
      }
    } catch {
      // 目录不存在或不可读，交给下面的判断
    }

    if (!latestAt || Number.isNaN(latestAt.getTime())) {
      return {
        key: 'backup',
        label: '数据备份',
        status: 'error',
        detail: '找不到任何备份文件，数据库一旦损坏将无法恢复',
        value: '0',
      };
    }

    const hours = (Date.now() - latestAt.getTime()) / 3600000;
    const detail = `上次备份 ${Math.round(hours)} 小时前${sizeMb ? `（${sizeMb} MB）` : ''}`;
    if (hours > 48) {
      return {
        key: 'backup',
        label: '数据备份',
        status: 'error',
        detail: `${detail}，已超过 48 小时，请检查 cron 与服务是否在跑`,
        value: `${Math.round(hours)}h`,
      };
    }
    if (hours > 26) {
      return {
        key: 'backup',
        label: '数据备份',
        status: 'warn',
        detail: `${detail}，超过 26 小时未备份`,
        value: `${Math.round(hours)}h`,
      };
    }
    return { key: 'backup', label: '数据备份', status: 'ok', detail, value: `${Math.round(hours)}h` };
  }

  private async checkQueue(): Promise<Check> {
    const [pending, overdue, stuck, activeChannels] = await Promise.all([
      this.prisma.recipient.count({ where: { status: 'queued' } }),
      this.prisma.recipient.count({ where: { status: 'queued', nextAttemptAt: { lte: new Date() } } }),
      this.prisma.recipient.count({
        where: { status: 'sending', updatedAt: { lt: new Date(Date.now() - 120000) } },
      }),
      this.prisma.channel.count({ where: { status: 'active' } }),
    ]);

    if (pending === 0 && stuck === 0) {
      return { key: 'queue', label: '发送队列', status: 'ok', detail: '队列空闲', value: '0' };
    }
    if (activeChannels === 0 && pending > 0) {
      return {
        key: 'queue',
        label: '发送队列',
        status: 'error',
        detail: `${pending} 封待发，但没有可用账号`,
        value: String(pending),
      };
    }
    if (stuck > 0) {
      return {
        key: 'queue',
        label: '发送队列',
        status: 'warn',
        detail: `${stuck} 封卡在发送中，2 分钟后由 worker 自动回收`,
        value: String(stuck),
      };
    }
    return {
      key: 'queue',
      label: '发送队列',
      status: 'ok',
      detail: `${pending} 封待发${overdue > 0 ? `（${overdue} 封已到期）` : ''}`,
      value: String(pending),
    };
  }

  async auditLogs(params: { page: number; pageSize: number; action?: string }) {
    const where = params.action ? { action: { contains: params.action } } : {};
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
    ]);
    return {
      total,
      page: params.page,
      pageSize: params.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        target: r.target,
        detail: r.detail,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 清理审计日志。
   *
   * 全清和按天数清都支持。注意这里**不手写一条"已清理"记录**：
   * 审计拦截器会在响应返回后自己写一条 ops.audit.clear，
   * 手写会变成两条，反而让人以为清了还剩。
   */
  async clearAuditLogs(params: { beforeDays: number; currentPassword: string; all?: boolean }) {
    const { beforeDays, currentPassword, all } = params;

    // 二次鉴权：会话 Cookie 被盗时，不能顺手把痕迹抹掉
    const account = await this.prisma.adminAccount.findUnique({ where: { id: 1 } });
    const passOk = account
      ? await bcrypt.compare(currentPassword ?? '', account.passwordHash).catch(() => false)
      : false;
    if (!passOk) throw new BadRequestException('当前密码不正确，无法清理审计日志');

    // 全清必须显式 all=1，且仍然保留最近 7 天，避免"两个请求抹掉全部痕迹"
    const days = all ? 7 : beforeDays;
    const where = { createdAt: { lt: new Date(Date.now() - days * 86400000) } };

    const before = await this.prisma.auditLog.count({ where });
    if (before === 0) return { deleted: 0, beforeDays: days };

    const r = await this.prisma.auditLog.deleteMany({ where });
    log.info({ deleted: r.count, beforeDays: days }, '已清理审计日志');
    return { deleted: r.count, beforeDays: days };
  }

  /** 手工标记一次备份时间，供备份脚本以外的场景使用 */
  async markBackup(at: string | undefined) {
    const raw = at ? new Date(at) : new Date();
    const now = Date.now();
    // 未来时间会让"备份是否及时"的检查永远通过，必须挡掉
    const valid =
      !Number.isNaN(raw.getTime()) && raw.getTime() <= now + 60_000 && raw.getTime() >= now - 7 * 86400000;
    const value = (valid ? raw : new Date()).toISOString();
    await this.prisma.systemState.upsert({
      where: { key: BACKUP_KEY },
      create: { key: BACKUP_KEY, value },
      update: { value },
    });
    return { ok: true, value };
  }

  async systemInfo() {
    return {
      day: calendarDay(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      // 绝对路径不对外回显：这是攻击者最想要的部署结构信息
      appUrl: this.cfg.appUrl,
      backupDir: this.cfg.backupDir ? '已配置' : '未配置',
      tlsCertPath: this.cfg.tlsCertPath ? '已配置' : '未配置',
      quotaToday: await this.todayQuota(),
    };
  }

  private async todayQuota() {
    const day = calendarDay();
    // 一条记录就是一个发件邮箱；额度只统计可用的那些，已发数按各自本地计数
    const channels = await this.prisma.channel.findMany();
    const activeChannels = channels.filter((c) => c.status === 'active');
    const limit = activeChannels.reduce((sum, c) => sum + c.dailyLimit, 0);
    const used = activeChannels.reduce(
      (sum, c) => sum + (isSameCalendarDay(c.quotaDate, day) ? Math.max(0, c.sentToday) : 0),
      0,
    );
    return {
      day,
      activeAccounts: activeChannels.length,
      limit,
      used,
      remaining: Math.max(0, limit - used),
    };
  }
}
