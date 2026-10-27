import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isRecurrence, nextOccurrence, RECURRENCE_LABEL, Recurrence } from '../common/recurrence';
import { PrismaService } from '../common/prisma.service';
import { CampaignRunnerService } from './campaign-runner.service';
import {
  CampaignVariantDto,
  CreateCampaignDto,
  QueryRecipientsDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

/** 排期至少留出这么点余量，避免刚点完就被调度器当成"已过期" */
const MIN_SCHEDULE_AHEAD_MS = 60_000;
/** 变体样本低于这个数就不下结论，20 个人的打开率差 5 个点毫无意义 */
const MIN_SAMPLE_FOR_WINNER = 10;

interface NormalizedVariant {
  label: string;
  subject: string | null;
  templateId: number | null;
  weight: number;
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CampaignRunnerService,
  ) {}

  async list(includeDeleted = false) {
    const rows = await this.prisma.campaign.findMany({
      where: includeDeleted ? { deletedAt: { not: null } } : { deletedAt: null },
      orderBy: { id: 'desc' },
      include: { variants: { select: { label: true } } },
    });
    const stats = await this.prisma.recipient.groupBy({
      by: ['campaignId', 'status'],
      _count: { _all: true },
    });

    const byCampaign = new Map<number, Record<string, number>>();
    for (const s of stats) {
      const m = byCampaign.get(s.campaignId) ?? {};
      m[s.status] = s._count._all;
      byCampaign.set(s.campaignId, m);
    }

    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      templateId: c.templateId,
      totalCount: c.totalCount,
      sendIntervalSec: c.sendIntervalSec,
      channelGroupIds: c.channelGroupIds,
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      recurrence: c.recurrence,
      recurrenceInterval: c.recurrenceInterval,
      recurrenceUntil: c.recurrenceUntil?.toISOString() ?? null,
      seriesId: c.seriesId,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      variantLabels: c.variants.map((v) => v.label),
      createdAt: c.createdAt.toISOString(),
      startedAt: c.startedAt?.toISOString() ?? null,
      finishedAt: c.finishedAt?.toISOString() ?? null,
      counts: byCampaign.get(c.id) ?? {},
    }));
  }

  async get(id: number) {
    const c = await this.getOrThrow(id);
    const [template, grouped, variantGroups, openedGroups, clickedGroups, variants] = await Promise.all([
      this.prisma.template.findUnique({ where: { id: c.templateId }, select: { id: true, name: true } }),
      this.prisma.recipient.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
      // 变体维度要单独按 (variant, status) 分组：全局的 status 分组里没有 variant 字段
      this.prisma.recipient.groupBy({
        by: ['variant', 'status'],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      this.prisma.recipient.groupBy({
        by: ['variant'],
        where: { campaignId: id, openedAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.recipient.groupBy({
        by: ['variant'],
        where: { campaignId: id, clickedAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.campaignVariant.findMany({ where: { campaignId: id }, orderBy: { label: 'asc' } }),
    ]);

    const counts: Record<string, number> = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, canceled: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;

    const failures = await this.prisma.recipient.findMany({
      where: { campaignId: id, status: 'failed' },
      orderBy: { id: 'desc' },
      take: 10,
      select: { id: true, email: true, attempts: true, errorCode: true, errorMessage: true },
    });

    const [openedCount, clickedCount] = await Promise.all([
      this.prisma.recipient.count({ where: { campaignId: id, openedAt: { not: null } } }),
      this.prisma.recipient.count({ where: { campaignId: id, clickedAt: { not: null } } }),
    ]);

    const done = counts.sent + counts.failed + counts.suppressed + counts.canceled;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      templateId: c.templateId,
      templateName: template?.name ?? null,
      listIds: c.listIds,
      channelIds: c.channelIds,
      channelGroupIds: c.channelGroupIds,
      sendIntervalSec: c.sendIntervalSec,
      sendIntervalMaxSec: c.sendIntervalMaxSec,
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      recurrence: c.recurrence,
      recurrenceInterval: c.recurrenceInterval,
      recurrenceUntil: c.recurrenceUntil?.toISOString() ?? null,
      seriesId: c.seriesId,
      deletedAt: c.deletedAt?.toISOString() ?? null,
      totalCount: c.totalCount,
      createdAt: c.createdAt.toISOString(),
      startedAt: c.startedAt?.toISOString() ?? null,
      finishedAt: c.finishedAt?.toISOString() ?? null,
      counts,
      openedCount,
      clickedCount,
      openRate: counts.sent > 0 ? Math.round((openedCount / counts.sent) * 1000) / 10 : 0,
      clickRate: counts.sent > 0 ? Math.round((clickedCount / counts.sent) * 1000) / 10 : 0,
      progress: c.totalCount > 0 ? Math.round((done / c.totalCount) * 100) : 0,
      recentFailures: failures,
      variantLabels: variants.map((v) => v.label),
      variants: variants.map((v) => ({
        label: v.label,
        subject: v.subject,
        templateId: v.templateId,
        weight: v.weight,
      })),
      variantStats: this.buildVariantStats(variants, variantGroups, openedGroups, clickedGroups),
      winnerLabel: this.pickWinner(variants, variantGroups, openedGroups),
    };
  }

  async create(dto: CreateCampaignDto) {
    this.assertInterval(dto.sendIntervalSec, dto.sendIntervalMaxSec);
    await this.assertRefs(dto.templateId, dto.listIds);
    const variants = await this.normalizeVariants(dto.variants);
    const recurrence = this.parseRecurrence(dto);

    const created = await this.prisma.campaign.create({
      data: {
        name: dto.name.trim(),
        templateId: dto.templateId,
        listIds: dto.listIds,
        channelIds: dto.channelIds ?? [],
        channelGroupIds: dto.channelGroupIds ?? [],
        sendIntervalSec: dto.sendIntervalSec ?? 30,
        sendIntervalMaxSec: dto.sendIntervalMaxSec ?? null,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: 'draft',
        ...(recurrence
          ? {
              recurrence: recurrence.kind,
              recurrenceInterval: recurrence.interval,
              recurrenceUntil: recurrence.until,
            }
          : {}),
        ...(variants.length > 0 ? { variants: { create: variants } } : {}),
      },
    });

    // 首轮自己就是序列头，seriesId 指向自身，后续由 worker 复制出下一轮
    if (recurrence) {
      await this.prisma.campaign.update({ where: { id: created.id }, data: { seriesId: created.id } });
    }
    return { id: created.id };
  }

  async update(id: number, dto: UpdateCampaignDto) {
    const c = await this.getOrThrow(id);
    if (c.status !== 'draft') {
      throw new BadRequestException('只有草稿状态的任务可以修改，已排期的任务请先取消排期');
    }
    if (dto.templateId !== undefined || dto.listIds !== undefined) {
      await this.assertRefs(dto.templateId ?? c.templateId, dto.listIds ?? c.listIds);
    }
    const variants = dto.variants === undefined ? null : await this.normalizeVariants(dto.variants);
    this.assertInterval(dto.sendIntervalSec, dto.sendIntervalMaxSec);
    const recurrenceData = this.recurrencePatch(dto);

    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.templateId !== undefined ? { templateId: dto.templateId } : {}),
          ...(dto.listIds !== undefined ? { listIds: dto.listIds } : {}),
          ...(dto.channelIds !== undefined ? { channelIds: dto.channelIds } : {}),
          ...(dto.channelGroupIds !== undefined ? { channelGroupIds: dto.channelGroupIds } : {}),
          ...(dto.sendIntervalSec !== undefined ? { sendIntervalSec: dto.sendIntervalSec } : {}),
          ...(dto.sendIntervalMaxSec !== undefined ? { sendIntervalMaxSec: dto.sendIntervalMaxSec } : {}),
          ...recurrenceData,
        },
      });
      if (variants !== null) {
        // 变体整体替换而不是逐条 diff：标签和权重互相牵连，
        // 半套更新很容易出现"A 还是旧的 50、B 已经是新的 30"这种不成立的组合。
        await tx.campaignVariant.deleteMany({ where: { campaignId: id } });
        if (variants.length > 0) {
          await tx.campaignVariant.createMany({
            data: variants.map((v) => ({ ...v, campaignId: id })),
          });
        }
      }
    });
    return { ok: true };
  }

  /**
   * 删除 = 进回收站。
   *
   * 群发任务是"做过的事"，物理删掉就连同投递明细一起没了，
   * 而投递明细是账单和合规记录。所以只标记，真删要再点一次"彻底删除"。
   */
  async remove(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status === 'running') throw new BadRequestException('任务正在发送，请先暂停或取消');
    if (c.status === 'scheduled') throw new BadRequestException('任务已排期，请先取消排期再删除');
    await this.prisma.campaign.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true, softDeleted: true };
  }

  /** 从回收站恢复 */
  async restore(id: number) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('任务不存在');
    if (!c.deletedAt) return { ok: true, already: true };
    await this.prisma.campaign.update({ where: { id }, data: { deletedAt: null } });
    return { ok: true };
  }

  /** 彻底删除：连投递明细一起，不可恢复 */
  async purge(id: number) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('任务不存在');
    if (!c.deletedAt) throw new BadRequestException('请先删除到回收站，再彻底删除');
    if (c.status === 'running') throw new BadRequestException('任务正在发送，不能彻底删除');
    await this.prisma.campaign.delete({ where: { id } });
    return { ok: true };
  }

  /** 停止整个周期序列：只清 recurrence，已发出的不受影响 */
  async stopSeries(id: number) {
    const c = await this.getOrThrow(id);
    const seriesId = c.seriesId ?? c.id;
    const res = await this.prisma.campaign.updateMany({
      where: { OR: [{ id: seriesId }, { seriesId }] },
      data: { recurrence: null, recurrenceUntil: null },
    });
    return { ok: true, affected: res.count };
  }

  /** 排期：草稿挂到未来的时间点，到点由 worker 启动 */
  async schedule(id: number, scheduledAt: string) {
    const c = await this.getOrThrow(id);
    if (c.status !== 'draft' && c.status !== 'scheduled') {
      throw new BadRequestException('只有草稿或已排期的任务可以设置发送时间');
    }

    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) throw new BadRequestException('发送时间格式不正确');
    if (when.getTime() < Date.now() + MIN_SCHEDULE_AHEAD_MS) {
      throw new BadRequestException('发送时间要晚于当前时间至少 1 分钟');
    }

    // 到点才发现分组是空的就太晚了：任务会静默退回草稿，用户以为已经排上了
    const audience = await this.countAudience(c.listIds);
    if (audience === 0) throw new BadRequestException('所选分组里没有可发送的已订阅联系人');

    await this.prisma.campaign.update({
      where: { id },
      data: { status: 'scheduled', scheduledAt: when },
    });
    return { ok: true, scheduledAt: when.toISOString(), audience };
  }

  async unschedule(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status !== 'scheduled') throw new BadRequestException('只有已排期的任务可以取消排期');
    await this.prisma.campaign.update({
      where: { id },
      data: { status: 'draft', scheduledAt: null },
    });
    return { ok: true };
  }

  /**
   * 开始发送：先原子领取任务状态，再展开投递明细。
   *
   * 分两步是因为展开要读几千个联系人、耗时几十毫秒到几秒；
   * 如果先展开再改状态，定时调度器可能在同一瞬间也展开一次。
   * 唯一索引能兜住重复投递，但两边都以为自己抢到了会重复写日志、重复报错。
   */
  async start(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status === 'running') throw new BadRequestException('任务已在发送中');
    if (c.status === 'done') throw new BadRequestException('任务已完成，如需重发请复制一份新任务');
    if (c.status === 'canceled') throw new BadRequestException('任务已取消');
    if (c.status === 'paused') throw new BadRequestException('任务已暂停，请用继续');

    const claimed = await this.prisma.campaign.updateMany({
      where: { id, status: { in: ['draft', 'scheduled'] } },
      data: { status: 'running', startedAt: c.startedAt ?? new Date(), finishedAt: null },
    });
    if (claimed.count !== 1) throw new BadRequestException('任务状态已变化，请刷新后重试');

    const result = await this.runner.materialize(id);
    if (result.total === 0) {
      await this.prisma.campaign.update({
        where: { id },
        data: { status: 'draft', startedAt: c.startedAt, finishedAt: null },
      });
      throw new BadRequestException('所选分组里没有可发送的已订阅联系人');
    }

    return { ok: true, ...result };
  }

  async pause(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status !== 'running') throw new BadRequestException('只有发送中的任务可以暂停');
    await this.prisma.campaign.update({ where: { id }, data: { status: 'paused' } });
    return { ok: true };
  }

  async resume(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status !== 'paused') throw new BadRequestException('只有已暂停的任务可以继续');
    await this.prisma.campaign.update({ where: { id }, data: { status: 'running' } });
    return { ok: true };
  }

  /** 取消：未发送的一律置为 canceled，已发出的不受影响 */
  async cancel(id: number) {
    const c = await this.getOrThrow(id);
    if (c.status === 'done' || c.status === 'canceled') {
      throw new BadRequestException('任务已经结束');
    }
    await this.prisma.recipient.updateMany({
      where: { campaignId: id, status: { in: ['queued', 'sending'] } },
      data: { status: 'canceled' },
    });
    await this.prisma.campaign.update({
      where: { id },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    return { ok: true };
  }

  async recipients(id: number, q: QueryRecipientsDto) {
    await this.getOrThrow(id);
    const page = Math.max(1, q.page || 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize || 20));
    const where = { campaignId: id, ...(q.status ? { status: q.status } : {}) };

    const [items, total] = await Promise.all([
      this.prisma.recipient.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.recipient.count({ where }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: items.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
        variant: r.variant,
        attempts: r.attempts,
        channelId: r.channelId,
        messageId: r.messageId,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
        openedAt: r.openedAt?.toISOString() ?? null,
      })),
    };
  }

  // ---------- 内部方法 ----------

  /** 每个变体的送达/打开/点击，用于判断哪一版更受欢迎 */
  private buildVariantStats(
    variants: { label: string; subject: string | null; weight: number }[],
    statusGroups: { variant: string | null; status: string; _count: { _all: number } }[],
    openedGroups: { variant: string | null; _count: { _all: number } }[],
    clickedGroups: { variant: string | null; _count: { _all: number } }[],
  ) {
    if (variants.length === 0) return [];

    const opened = new Map<string, number>();
    openedGroups.forEach((g) => g.variant && opened.set(g.variant, g._count._all));
    const clicked = new Map<string, number>();
    clickedGroups.forEach((g) => g.variant && clicked.set(g.variant, g._count._all));

    return variants.map((v) => {
      const mine = statusGroups.filter((g) => g.variant === v.label);
      const pick = (s: string) => mine.find((g) => g.status === s)?._count._all ?? 0;
      const sent = pick('sent');
      const o = opened.get(v.label) ?? 0;
      const c = clicked.get(v.label) ?? 0;
      return {
        label: v.label,
        subject: v.subject,
        weight: v.weight,
        total: mine.reduce((s, g) => s + g._count._all, 0),
        sent,
        failed: pick('failed'),
        pending: pick('queued') + pick('sending'),
        opened: o,
        clicked: c,
        openRate: sent > 0 ? Math.round((o / sent) * 1000) / 10 : 0,
        clickRate: sent > 0 ? Math.round((c / sent) * 1000) / 10 : 0,
      };
    });
  }

  /**
   * 挑一个"胜出"的变体。
   * 样本不够时返回 null——20 封里差 2 个打开就是 10 个百分点，
   * 这种结论拿去指导下一轮只会误导。
   */
  private pickWinner(
    variants: { label: string }[],
    statusGroups: { variant: string | null; status: string; _count: { _all: number } }[],
    openedGroups: { variant: string | null; _count: { _all: number } }[],
  ): string | null {
    if (variants.length < 2) return null;
    const sentBy = new Map<string, number>();
    statusGroups
      .filter((g) => g.status === 'sent' && g.variant)
      .forEach((g) => sentBy.set(g.variant as string, g._count._all));
    if (variants.some((v) => (sentBy.get(v.label) ?? 0) < MIN_SAMPLE_FOR_WINNER)) return null;

    const openedBy = new Map<string, number>();
    openedGroups.forEach((g) => g.variant && openedBy.set(g.variant, g._count._all));

    let best: { label: string; rate: number } | null = null;
    for (const v of variants) {
      const sent = sentBy.get(v.label) ?? 0;
      const rate = sent > 0 ? (openedBy.get(v.label) ?? 0) / sent : 0;
      if (!best || rate > best.rate) best = { label: v.label, rate };
    }
    return best?.label ?? null;
  }

  /** 校验并补齐变体：标签唯一、权重有默认值、至少有一处和主模板不同 */
  private async normalizeVariants(input?: CampaignVariantDto[]): Promise<NormalizedVariant[]> {
    if (!input || input.length === 0) return [];
    if (input.length === 1) {
      throw new BadRequestException('A/B 测试至少需要两个变体，单变体请直接填任务模板');
    }

    const seen = new Set<string>();
    const out: NormalizedVariant[] = [];
    for (const v of input) {
      const label = v.label.trim().toUpperCase();
      if (seen.has(label)) throw new BadRequestException(`变体标签 ${label} 重复`);
      seen.add(label);

      const subject = v.subject?.trim() ? v.subject.trim() : null;
      const templateId = v.templateId ?? null;
      if (!subject && !templateId) {
        throw new BadRequestException(`变体 ${label} 没有做任何改变，请至少改主题或换模板`);
      }
      out.push({ label, subject, templateId, weight: v.weight ?? 50 });
    }

    const templateIds = out.map((v) => v.templateId).filter((x): x is number => x !== null);
    if (templateIds.length > 0) {
      const found = await this.prisma.template.count({ where: { id: { in: templateIds } } });
      if (found !== new Set(templateIds).size) throw new BadRequestException('变体引用的模板不存在');
    }
    return out;
  }

  /**
   * 受众人数：分组里的联系人减去抑制名单。
   * 预估必须和实际展开用同一把尺子，否则会出现"显示 2 人、只发 1 封"的落差。
   */
  private async countAudience(listIds: number[]): Promise<number> {
    if (listIds.length === 0) return 0;
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(DISTINCT c.id) AS count
        FROM contacts c
        JOIN list_members lm ON lm.contact_id = c.id
       WHERE lm.list_id = ANY(${listIds}::int[])
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`;
    return Number(rows[0]?.count ?? 0);
  }

  /** 分组人数与可投递人数，用于向导里如实展示 */
  async audienceInfo(listIds: number[]) {
    if (listIds.length === 0) return { total: 0, reachable: 0, skipped: 0 };
    const totalRows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(DISTINCT c.id) AS count
        FROM contacts c
        JOIN list_members lm ON lm.contact_id = c.id
       WHERE lm.list_id = ANY(${listIds}::int[])`;
    const total = Number(totalRows[0]?.count ?? 0);
    const reachable = await this.countAudience(listIds);
    return { total, reachable, skipped: Math.max(0, total - reachable) };
  }

  /** 随机区间的上下界必须自洽：最大不能小于最小 */
  private assertInterval(min?: number, max?: number) {
    if (min !== undefined && max !== undefined && max < min) {
      throw new BadRequestException('最大间隔不能小于最小间隔');
    }
  }

  /** 校验周期设置：类型合法、间隔 1–52、截止时间必须晚于首次发送时间 */
  private parseRecurrence(dto: {
    recurrence?: string;
    recurrenceInterval?: number;
    recurrenceUntil?: string;
    scheduledAt?: string;
  }): { kind: Recurrence; interval: number; until: Date | null } | null {
    if (!dto.recurrence || dto.recurrence === 'none') return null;
    if (!isRecurrence(dto.recurrence)) throw new BadRequestException('周期只支持每天/每周/每月');

    const interval = dto.recurrenceInterval ?? 1;
    if (!Number.isFinite(interval) || interval < 1 || interval > 52) {
      throw new BadRequestException('周期间隔需在 1–52 之间');
    }

    let until: Date | null = null;
    if (dto.recurrenceUntil) {
      until = new Date(dto.recurrenceUntil);
      if (Number.isNaN(until.getTime())) throw new BadRequestException('周期截止时间格式不正确');
      if (dto.scheduledAt) {
        const first = new Date(dto.scheduledAt);
        if (until.getTime() <= first.getTime()) {
          throw new BadRequestException('周期截止时间要晚于首次发送时间');
        }
      }
    }
    return { kind: dto.recurrence, interval: Math.trunc(interval), until };
  }

  /** 更新时的周期补丁：undefined = 不动，'none' = 关闭周期 */
  private recurrencePatch(dto: {
    recurrence?: string;
    recurrenceInterval?: number;
    recurrenceUntil?: string;
    scheduledAt?: string;
  }): Record<string, unknown> {
    if (dto.recurrence === undefined && dto.recurrenceInterval === undefined && dto.recurrenceUntil === undefined) {
      return {};
    }
    if (dto.recurrence === 'none') {
      return { recurrence: null, recurrenceUntil: null, recurrenceInterval: 1 };
    }
    const parsed = this.parseRecurrence(dto);
    if (!parsed) return {};
    return {
      recurrence: parsed.kind,
      recurrenceInterval: parsed.interval,
      recurrenceUntil: parsed.until,
    };
  }

  private async getOrThrow(id: number) {
    // 回收站里的任务对常规入口一律不可见
    const c = await this.prisma.campaign.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new NotFoundException('任务不存在');
    return c;
  }

  private async assertRefs(templateId: number, listIds: number[]) {
    const template = await this.prisma.template.findFirst({ where: { id: templateId, deletedAt: null } });
    if (!template) throw new BadRequestException('模板不存在或已删除');
    const lists = await this.prisma.list.count({ where: { id: { in: listIds } } });
    if (lists !== listIds.length) throw new BadRequestException('有分组不存在');
  }
}
