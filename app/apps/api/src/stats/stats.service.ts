import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { calendarDay, dayStartUtc, addDays, recentDays } from '../common/quota';
import { isSameCalendarDay } from '../common/quota';

export type AlertLevel = 'error' | 'warn' | 'info';

export interface Alert {
  level: AlertLevel;
  code: string;
  message: string;
  hint?: string;
}

/** 比率统一按 0~100 的百分比返回，前端不再做换算 */
function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 运营概览。
   *
   * 两个窗口刻意分开：
   * - 今日：配额是否够用，今天是干活的视角
   * - 最近 N 天：送达率/打开率这类比率，太短没有统计意义
   */
  async overview(windowDays = 30) {
    const today = calendarDay();
    const todayStart = dayStartUtc(today);
    const tomorrowStart = dayStartUtc(addDays(today, 1));

    const windowStart = dayStartUtc(addDays(today, -(windowDays - 1)));

    const [
      todaySent,
      todayOpened,
      todayClicked,
      todayFailed,
      todayNewContacts,
      channels,
      contactGroups,
      campaignGroups,
      queueGroups,
      overdue,
      totalContacts,
      totalSuppressed,
      windowRecipients,
      windowEvents,
      activeCampaigns,
    ] = await Promise.all([
      this.prisma.recipient.count({
        where: { sentAt: { gte: todayStart, lt: tomorrowStart } },
      }),
      this.prisma.recipient.count({
        where: { openedAt: { gte: todayStart, lt: tomorrowStart } },
      }),
      this.prisma.recipient.count({
        where: { clickedAt: { gte: todayStart, lt: tomorrowStart } },
      }),
      this.prisma.recipient.count({
        where: {
          status: { in: ['failed', 'suppressed'] },
          sentAt: null,
          updatedAt: { gte: todayStart, lt: tomorrowStart },
        },
      }),
      this.prisma.contact.count({ where: { createdAt: { gte: todayStart, lt: tomorrowStart } } }),
      this.prisma.channel.findMany({
        select: {
          id: true,
          fromEmail: true,
          host: true,
          username: true,
          status: true,
          dailyLimit: true,
          sentToday: true,
          quotaDate: true,
          lastSentAt: true,
          consecutiveFailures: true,
          lastError: true,
          lastErrorAt: true,
          lastOkAt: true,
        },
        orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.suppression.groupBy({ by: ['reason'], _count: { _all: true } }),
      this.prisma.campaign.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.recipient.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.recipient.count({
        where: { status: 'queued', nextAttemptAt: { lte: new Date() } },
      }),
      this.prisma.contact.count(),
      this.prisma.suppression.count(),
      // 窗口内的送达/失败，用于算送达率
      this.prisma.recipient.groupBy({
        by: ['status'],
        where: { OR: [{ sentAt: { gte: windowStart } }, { updatedAt: { gte: windowStart } }] },
        _count: { _all: true },
      }),
      this.prisma.event.groupBy({
        by: ['type'],
        where: { createdAt: { gte: windowStart } },
        _count: { _all: true },
      }),
      this.prisma.campaign.count({
        where: { deletedAt: null, status: { in: ['running', 'scheduled', 'paused'] } },
      }),
    ]);

    // 一条记录就是一个发件邮箱：各自有独立的每日上限与已发计数
    const todayUsed = (c: (typeof channels)[number]) =>
      isSameCalendarDay(c.quotaDate, today) ? Math.max(0, c.sentToday) : 0;
    const activeRows = channels.filter((c) => c.status === 'active');
    const totalLimit = activeRows.reduce((sum, c) => sum + c.dailyLimit, 0);
    const quotaUsed = activeRows.reduce((sum, c) => sum + todayUsed(c), 0);

    const counts: Record<string, number> = {};
    for (const g of queueGroups) counts[g.status] = g._count._all;

    const suppressCounts: Record<string, number> = {};
    for (const g of contactGroups) suppressCounts[g.reason] = g._count._all;

    const campaignCounts: Record<string, number> = {};
    for (const g of campaignGroups) campaignCounts[g.status] = g._count._all;

    // 窗口内比率：分母只取"已经有结果"的投递，排队的不能算进送达率的分子或分母
    let wSent = 0;
    let wFailed = 0;
    for (const g of windowRecipients) {
      if (g.status === 'sent') wSent = g._count._all;
      if (g.status === 'failed' || g.status === 'suppressed') wFailed += g._count._all;
    }
    const eventCounts: Record<string, number> = {};
    for (const g of windowEvents) eventCounts[g.type] = g._count._all;

    const [windowOpened, windowClicked] = await Promise.all([
      this.prisma.recipient.count({ where: { openedAt: { gte: windowStart } } }),
      this.prisma.recipient.count({ where: { clickedAt: { gte: windowStart } } }),
    ]);

    const settled = wSent + wFailed;

    const alerts = this.buildAlerts({
      accounts: channels.map((c) => ({
        id: c.id,
        fromEmail: c.fromEmail,
        status: c.status,
        limit: c.dailyLimit,
        used: todayUsed(c),
        consecutiveFailures: c.consecutiveFailures,
        lastError: c.lastError,
      })),
      quotaRemaining: totalLimit - quotaUsed,
      overdue,
      pending: counts.queued ?? 0,
      stuckSending: counts.sending ?? 0,
      activeCampaigns,
    });

    return {
      today: {
        day: today,
        sent: todaySent,
        opened: todayOpened,
        clicked: todayClicked,
        failed: todayFailed,
        newContacts: todayNewContacts,
      },
      quota: {
        total: channels.length,
        active: activeRows.length,
        totalLimit,
        used: quotaUsed,
        remaining: Math.max(0, totalLimit - quotaUsed),
        // 配额消耗百分比，用于进度条
        usedPct: pct(quotaUsed, totalLimit),
      },
      queue: {
        pending: counts.queued ?? 0,
        sending: counts.sending ?? 0,
        overdue,
        failed: counts.failed ?? 0,
        suppressed: counts.suppressed ?? 0,
      },
      totals: {
        contacts: totalContacts,
        // 可投递 = 总联系人里不在抑制名单的（抑制名单是唯一的"别发"依据）
        reachable: Math.max(0, totalContacts - totalSuppressed),
        bouncedContacts: suppressCounts.bounce ?? 0,
        suppressed: totalSuppressed,
        campaigns: [...campaignGroups].reduce((s, g) => s + g._count._all, 0),
        activeCampaigns,
        doneCampaigns: campaignCounts.done ?? 0,
      },
      rates: {
        windowDays,
        settled,
        delivered: pct(wSent, settled),
        bounced: pct(wFailed, settled),
        opened: pct(windowOpened, wSent),
        clicked: pct(windowClicked, wSent),
      },
      accounts: channels.map((c) => ({
        id: c.id,
        fromEmail: c.fromEmail,
        host: c.host,
        username: c.username,
        status: c.status,
        used: todayUsed(c),
        limit: c.dailyLimit,
        remaining: Math.max(0, c.dailyLimit - todayUsed(c)),
        consecutiveFailures: c.consecutiveFailures,
        lastError: c.lastError,
        lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
        lastOkAt: c.lastOkAt?.toISOString() ?? null,
      })),
      alerts,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 按天趋势。日期必须按业务时区切分——
   * sent_at 是 UTC 墙上时间，直接 ::date 会按 UTC 零点切，北京时间早上 8 点前的信会算到前一天。
   */
  async trend(days = 14) {
    const list = recentDays(days);
    const from = dayStartUtc(list[0]);
    const to = dayStartUtc(addDays(list[list.length - 1], 1));

    const rows = await this.prisma.$queryRaw<
      { day: string; sent: bigint; opened: bigint; clicked: bigint; failed: bigint }[]
    >`
      SELECT
        to_char((sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
        count(*)                                                                                AS sent,
        count(*) FILTER (WHERE opened_at IS NOT NULL)                                            AS opened,
        count(*) FILTER (WHERE clicked_at IS NOT NULL)                                           AS clicked,
        0::bigint                                                                                AS failed
      FROM recipients
      WHERE sent_at >= ${from} AND sent_at < ${to}
      GROUP BY 1

      UNION ALL

      SELECT
        to_char((updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
        0::bigint                                                                                 AS sent,
        0::bigint                                                                                 AS opened,
        0::bigint                                                                                 AS clicked,
        count(*)                                                                                   AS failed
      FROM recipients
      WHERE sent_at IS NULL
        AND status IN ('failed', 'suppressed')
        AND updated_at >= ${from} AND updated_at < ${to}
      GROUP BY 1
    `;

    const agg = new Map<string, { sent: number; opened: number; clicked: number; failed: number }>();
    for (const d of list) agg.set(d, { sent: 0, opened: 0, clicked: 0, failed: 0 });
    for (const r of rows) {
      const slot = agg.get(r.day);
      if (!slot) continue;
      slot.sent += Number(r.sent);
      slot.opened += Number(r.opened);
      slot.clicked += Number(r.clicked);
      slot.failed += Number(r.failed);
    }

    return list.map((day) => ({ day, ...agg.get(day)! }));
  }

  /** 各真实账号在窗口内的表现，用于判断哪个账号在拖后腿 */
  async byChannel(days = 30) {
    const today = calendarDay();
    const from = dayStartUtc(addDays(today, -(days - 1)));

    const channels = await this.prisma.channel.findMany({
      select: {
        id: true,
        fromEmail: true,
        host: true,
        username: true,
        status: true,
        dailyLimit: true,
        sentToday: true,
        quotaDate: true,
        lastSentAt: true,
        consecutiveFailures: true,
        lastError: true,
        lastErrorAt: true,
        lastOkAt: true,
      },
      orderBy: { id: 'asc' },
    });

    const grouped = await this.prisma.recipient.groupBy({
      by: ['channelId', 'status'],
      where: { channelId: { not: null }, updatedAt: { gte: from } },
      _count: { _all: true },
    });

    const map = new Map<number, { sent: number; failed: number; suppressed: number }>();
    for (const g of grouped) {
      if (g.channelId == null) continue;
      const key = g.channelId;
      const m = map.get(key) ?? { sent: 0, failed: 0, suppressed: 0 };
      if (g.status === 'sent') m.sent += g._count._all;
      if (g.status === 'failed') m.failed += g._count._all;
      if (g.status === 'suppressed') m.suppressed += g._count._all;
      map.set(key, m);
    }

    return channels
      .map((c) => {
        const m = map.get(c.id) ?? { sent: 0, failed: 0, suppressed: 0 };
        const settled = m.sent + m.failed;
        const used = isSameCalendarDay(c.quotaDate, today) ? Math.max(0, c.sentToday) : 0;
        return {
          id: c.id,
          fromEmail: c.fromEmail,
          host: c.host,
          username: c.username,
          status: c.status,
          usedToday: used,
          dailyLimit: c.dailyLimit,
          remaining: Math.max(0, c.dailyLimit - used),
          // 窗口内的吞吐：按满配额算每天能发多少
          sent: m.sent,
          failed: m.failed,
          suppressed: m.suppressed,
          successRate: pct(m.sent, settled),
          consecutiveFailures: c.consecutiveFailures,
          lastError: c.lastError,
          lastOkAt: c.lastOkAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => a.id - b.id);
  }

  /** 任务对比：把每个任务的送达/打开/点击放在一起看，便于判断内容质量 */
  async byCampaign(limit = 20) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { deletedAt: null },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        status: true,
        totalCount: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    const ids = campaigns.map((c) => c.id);
    if (ids.length === 0) return [];

    const grouped = await this.prisma.recipient.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    });
    const opened = await this.prisma.recipient.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, openedAt: { not: null } },
      _count: { _all: true },
    });
    const clicked = await this.prisma.recipient.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, clickedAt: { not: null } },
      _count: { _all: true },
    });

    const counts = new Map<number, Record<string, number>>();
    for (const g of grouped) {
      const m = counts.get(g.campaignId) ?? {};
      m[g.status] = g._count._all;
      counts.set(g.campaignId, m);
    }
    const openMap = new Map(opened.map((o) => [o.campaignId, o._count._all]));
    const clickMap = new Map(clicked.map((o) => [o.campaignId, o._count._all]));

    return campaigns.map((c) => {
      const m = counts.get(c.id) ?? {};
      const sent = m.sent ?? 0;
      const failed = m.failed ?? 0;
      const suppressed = m.suppressed ?? 0;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        totalCount: c.totalCount,
        sent,
        failed,
        suppressed,
        pending: m.queued ?? 0,
        delivered: pct(sent, sent + failed + suppressed),
        opened: openMap.get(c.id) ?? 0,
        clicked: clickMap.get(c.id) ?? 0,
        openRate: pct(openMap.get(c.id) ?? 0, sent),
        clickRate: pct(clickMap.get(c.id) ?? 0, sent),
        createdAt: c.createdAt.toISOString(),
        startedAt: c.startedAt?.toISOString() ?? null,
        finishedAt: c.finishedAt?.toISOString() ?? null,
        // 实际运行时长（秒），用来判断配置的间隔是否被遵守
        durationSec:
          c.startedAt && c.finishedAt
            ? Math.max(0, Math.round((c.finishedAt.getTime() - c.startedAt.getTime()) / 1000))
            : null,
      };
    });
  }

  /** 失败原因分布：按 error_code 聚，直接告诉用户"卡在哪一步" */
  async failures(days = 30) {
    const from = dayStartUtc(addDays(calendarDay(), -(days - 1)));
    const rows = await this.prisma.recipient.groupBy({
      by: ['errorCode'],
      where: {
        status: { in: ['failed', 'suppressed'] },
        updatedAt: { gte: from },
      },
      _count: { _all: true },
      orderBy: { _count: { errorCode: 'desc' } },
    });
    return rows
      .map((r) => ({ code: r.errorCode ?? 'UNKNOWN', count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  private buildAlerts(input: {
    accounts: {
      id: number;
      fromEmail: string;
      status: string;
      limit: number;
      used: number;
      consecutiveFailures: number;
      lastError: string | null;
    }[];
    quotaRemaining: number;
    overdue: number;
    pending: number;
    stuckSending: number;
    activeCampaigns: number;
  }): Alert[] {
    const alerts: Alert[] = [];

    for (const a of input.accounts) {
      if (a.status === 'error') {
        alerts.push({
          level: 'error',
          code: 'ACCOUNT_ERROR',
          message: `发件邮箱「${a.fromEmail}」已被自动停用`,
          hint: a.lastError ?? '连续发送失败达到阈值，请检查账号状态或密码后重新启用',
        });
      } else if (a.status === 'active' && a.consecutiveFailures >= 2) {
        alerts.push({
          level: 'warn',
          code: 'CHANNEL_DEGRADED',
          message: `发件邮箱「${a.fromEmail}」连续失败 ${a.consecutiveFailures} 次`,
          hint: a.lastError ?? '再有 1 次失败将被自动停用',
        });
      }
    }

    const active = input.accounts.filter((a) => a.status === 'active');
    if (active.length === 0 && input.accounts.length > 0) {
      alerts.push({
        level: 'error',
        code: 'NO_ACTIVE_ACCOUNT',
        message: '没有任何可用的发件邮箱',
        hint: '所有账号都被停用或暂停，队列里的邮件不会发出',
      });
    } else if (active.length > 0 && input.quotaRemaining === 0) {
      alerts.push({
        level: 'warn',
        code: 'QUOTA_EXHAUSTED',
        message: '今日发送配额已全部用完',
        hint: '剩余邮件会等到明天配额重置后自动继续发送',
      });
    }

    if (input.stuckSending > 0) {
      alerts.push({
        level: 'warn',
        code: 'STUCK_SENDING',
        message: `${input.stuckSending} 封邮件卡在发送中状态`,
        hint: '超过 2 分钟未更新会被自动回收重发，若持续出现请检查 worker 是否正常',
      });
    }

    if (input.overdue > 5) {
      alerts.push({
        level: 'warn',
        code: 'QUEUE_OVERDUE',
        message: `${input.overdue} 封邮件已到发送时间但仍未发出`,
        hint: '常见原因是配额不足、账号间隔冷却或 worker 未运行',
      });
    }

    if (input.pending > 0 && input.activeCampaigns === 0) {
      alerts.push({
        level: 'info',
        code: 'ORPHAN_QUEUE',
        message: `${input.pending} 封邮件在队列中，但没有进行中的任务`,
        hint: '任务可能已暂停或被取消，检查任务状态',
      });
    }

    const order: Record<AlertLevel, number> = { error: 0, warn: 1, info: 2 };
    return alerts.sort((a, b) => order[a.level] - order[b.level]);
  }
}
