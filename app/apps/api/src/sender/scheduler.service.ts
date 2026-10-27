import { Injectable } from '@nestjs/common';
import { CampaignVariant } from '@prisma/client';
import { CampaignRunnerService } from '../campaigns/campaign-runner.service';
import { log } from '../common/logger';
import { PrismaService } from '../common/prisma.service';
import { nextOccurrence, Recurrence } from '../common/recurrence';

/** 一次最多同时启动几个定时任务，避免某一秒到期的任务把发送循环卡住 */
const MAX_PER_ROUND = 10;
/** 每轮最多检查多少条已完成的周期任务，防止历史数据把这一轮拖长 */
const MAX_RECURRING_SCAN = 60;

/**
 * 定时发送与周期任务的调度器。
 *
 * 挂在 worker 里而不是 API 里：API 可能重启、可能部署多份，
 * 而"到点开跑"这件事必须只由唯一一个常驻进程负责。worker 本来就是单实例常驻，
 * 再加上条件更新（status = 'scheduled' 才能领取），即便将来起两个 worker 也不会重复启动。
 *
 * 轮询而不是定时器排队：重启后不需要恢复内存里的定时任务，
 * 库里的 scheduled_at 就是唯一真相。代价是精度取决于轮询间隔（30 秒），
 * 对邮件群发这种场景完全够用。
 */
@Injectable()
export class SchedulerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CampaignRunnerService,
  ) {}

  async runDue(now: Date = new Date()): Promise<number[]> {
    const fired = await this.fireDue(now);
    // 周期任务放在启动之后：这一轮刚发的任务不可能是"已完成"，不会互相干扰
    await this.spawnRecurring(now).catch((e) =>
      log.warn({ err: e?.message ?? String(e) }, '周期任务生成失败，下一轮重试'),
    );
    return fired;
  }

  private async fireDue(now: Date): Promise<number[]> {
    const due = await this.prisma.campaign.findMany({
      where: { status: 'scheduled', deletedAt: null, scheduledAt: { lte: now } },
      select: { id: true, name: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_PER_ROUND,
    });
    if (due.length === 0) return [];

    const fired: number[] = [];
    for (const c of due) {
      const claimed = await this.prisma.campaign.updateMany({
        where: { id: c.id, status: 'scheduled' },
        data: { status: 'running', startedAt: new Date(), finishedAt: null },
      });
      // 条件更新没抢到：另一个进程已经启动了这条任务，跳过即可
      if (claimed.count !== 1) continue;

      try {
        const r = await this.runner.materialize(c.id);
        if (r.total === 0) {
          // 排期后分组里的人全都不可投递的极端情况：退回草稿并清掉时间，不要让它反复到点空跑
          await this.prisma.campaign.update({
            where: { id: c.id },
            data: { status: 'draft', scheduledAt: null },
          });
          log.warn({ campaignId: c.id }, '定时任务到点但分组已无可发送联系人，已退回草稿');
          continue;
        }
        fired.push(c.id);
        log.info(
          { campaignId: c.id, name: c.name, total: r.total, plannedAt: c.scheduledAt?.toISOString() },
          '定时任务已启动',
        );
      } catch (e: any) {
        // 展开失败必须回退状态，否则会永远卡在 running 而队列是空的
        await this.prisma.campaign
          .updateMany({
            where: { id: c.id, status: 'running' },
            data: { status: 'draft', scheduledAt: null },
          })
          .catch(() => undefined);
        log.error({ campaignId: c.id, err: e?.message ?? String(e) }, '定时任务启动失败，已退回草稿');
      }
    }
    return fired;
  }

  /**
   * 周期任务：给刚跑完的那一轮生成下一轮。
   *
   * 只处理 status='done'：用户主动取消（canceled）意味着"别再来下一次了"，
   * 如果取消后系统还继续生成，那是最让人恼火的一种行为。
   *
   * 幂等靠"是否已存在更晚的一轮"判断：生成过就不会再生成，
   * 即使这一轮被重复扫描也不会多出一条。
   */
  private async spawnRecurring(now: Date): Promise<void> {
    const finished = await this.prisma.campaign.findMany({
      where: { recurrence: { not: null }, status: 'done', deletedAt: null },
      include: { variants: true },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: MAX_RECURRING_SCAN,
    });
    if (finished.length === 0) return;

    // 同一序列只看最晚那一轮，避免把中间轮次也当成"待生成下一轮"
    const latest = new Map<number, (typeof finished)[number]>();
    for (const c of finished) {
      const key = c.seriesId ?? c.id;
      const seen = latest.get(key);
      if (!seen) {
        latest.set(key, c);
        continue;
      }
      const a = c.scheduledAt?.getTime() ?? 0;
      const b = seen.scheduledAt?.getTime() ?? 0;
      if (a > b || (a === b && c.id > seen.id)) latest.set(key, c);
    }

    for (const parent of latest.values()) {
      const seriesId = parent.seriesId ?? parent.id;
      const base = parent.scheduledAt ?? parent.finishedAt ?? now;
      const nextAt = nextOccurrence(base, parent.recurrence as Recurrence, parent.recurrenceInterval);

      if (parent.recurrenceUntil && nextAt.getTime() > parent.recurrenceUntil.getTime()) {
        log.info({ campaignId: parent.id, nextAt: nextAt.toISOString() }, '周期任务已到截止时间，不再生成');
        continue;
      }

      const later = await this.prisma.campaign.count({
        where: { seriesId, id: { not: parent.id }, scheduledAt: { gt: base } },
      });
      if (later > 0) continue;

      try {
        const child = await this.prisma.campaign.create({
          data: {
            name: parent.name,
            templateId: parent.templateId,
            listIds: parent.listIds,
            channelIds: parent.channelIds,
            sendIntervalSec: parent.sendIntervalSec,
            scheduledAt: nextAt,
            status: 'scheduled',
            recurrence: parent.recurrence,
            recurrenceInterval: parent.recurrenceInterval,
            recurrenceUntil: parent.recurrenceUntil,
            seriesId,
            ...(parent.variants.length > 0
              ? {
                  variants: {
                    create: parent.variants.map((v: CampaignVariant) => ({
                      label: v.label,
                      subject: v.subject,
                      templateId: v.templateId,
                      weight: v.weight,
                    })),
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        log.info(
          { seriesId, from: parent.id, to: child.id, scheduledAt: nextAt.toISOString() },
          '已生成下一轮周期任务',
        );
      } catch (e: any) {
        log.error({ seriesId, err: e?.message ?? String(e) }, '生成下一轮周期任务失败');
      }
    }
  }
}
