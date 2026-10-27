import { Inject, Injectable } from '@nestjs/common';
import { Campaign, Channel, Recipient, Template } from '@prisma/client';
import { AccountPool, accountKey, groupAccounts } from '../common/accounts';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';
import { calendarDay } from '../common/quota';
import { MailService, OutgoingAttachment } from '../mail/mail.service';
import { buildVars, htmlToText, renderHtml, renderSubject, renderTextBody } from '../templates/render';
import { TrackingService } from '../tracking/tracking.service';
import { log } from '../common/logger';

/** 4xx 临时失败的重试间隔：1 分钟 / 5 分钟 / 30 分钟 */
const RETRY_BACKOFF_SEC = [60, 300, 1800];
/** 重试次数上限（不含首次发送） */
const MAX_RETRIES = 3;

const IDLE_WAIT_MS = 3000;
const NO_CHANNEL_WAIT_MS = 10000;
const MAX_SLEEP_MS = 20000;
/**
 * sending 状态超过这个时间没更新，视为进程崩溃遗留。
 * 必须大于 SMTP 会话的最长耗时（socketTimeout 30s），否则会把正在发的信当成僵尸回收，
 * 造成重复投递。代价是崩溃时那封信最多卡 2 分钟才被回收——这是 at-least-once 的必然取舍。
 */
const STALE_SENDING_MS = 2 * 60 * 1000;

export interface ClaimedRow {
  id: number;
  campaign_id: number;
  contact_id: number;
  email: string;
  attempts: number;
  /** A/B 变体标签，未启用 A/B 的任务为空 */
  variant: string | null;
}

export type TickAction = 'sent' | 'retry' | 'failed' | 'idle' | 'no-channel' | 'halted';

export interface TickResult {
  action: TickAction;
  waitMs: number;
  campaignId?: number;
  email?: string;
  detail?: string;
}

@Injectable()
export class SenderService {
  private stopping = false;
  private lastSendByCampaign = new Map<number, number>();
  /**
   * 每个任务当前这一轮使用的间隔（毫秒）。
   * 随机区间不能在每次 tick 里重抽：computeWait 每轮都会被调用，
   * 重抽会让"还差多久"不断变化，实际间隔被推向区间上限。
   * 所以每发出一个收件人才重抽一次，整个等待期都用同一个目标值。
   */
  private gapByCampaign = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tracking: TrackingService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  get stopped(): boolean {
    return this.stopping;
  }

  /**
   * 进程崩溃会留下卡在 sending 的记录。启动时统一回收，
   * 否则这些收件人永远不会再被取到。
   */
  async recoverStale(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_SENDING_MS);
    const res = await this.prisma.recipient.updateMany({
      where: { status: 'sending', updatedAt: { lt: cutoff } },
      data: { status: 'queued', nextAttemptAt: new Date() },
    });
    return res.count;
  }

  /** 一次 tick = 取一封 → 选通道 → 渲染 → 发送 → 落状态 */
  async tick(): Promise<TickResult> {
    if (this.stopping) return { action: 'idle', waitMs: 0 };

    const claimed = await this.claim();
    if (!claimed) return { action: 'idle', waitMs: IDLE_WAIT_MS };

    const campaign = await this.prisma.campaign.findUnique({ where: { id: claimed.campaign_id } });
    if (!campaign || campaign.status !== 'running') {
      // 任务被暂停或取消：把这封放回队列，不留 sending 残影
      await this.release(claimed.id, NO_CHANNEL_WAIT_MS);
      return { action: 'halted', waitMs: IDLE_WAIT_MS, campaignId: claimed.campaign_id };
    }

    // A/B 变体只覆盖主题或模板，追踪开关、附件等仍以最终选中的那份模板为准
    const { template, subjectTemplate } = await this.resolveTemplate(campaign, claimed.variant);
    if (!template) {
      await this.failPermanently(claimed, '模板不存在', 'TEMPLATE_MISSING');
      await this.finishIfDone(campaign.id);
      return { action: 'failed', waitMs: 0, campaignId: campaign.id, email: claimed.email };
    }

    const day = calendarDay();
    const selection = await this.selectChannel(campaign, day);
    if (!selection.channel) {
      // 只把收件人推迟到通道真正可用的时间点，不要一刀切推后 10 秒：
      // 否则配置 4 秒间隔实际会跑成 14 秒（多发一封要等一脸懵逼的 10 秒）
      const delay = Math.max(1000, Math.min(selection.readyInMs + 300, 60000));
      await this.release(claimed.id, delay);
      return {
        action: 'no-channel',
        waitMs: delay,
        campaignId: campaign.id,
      };
    }

    const channel = selection.channel;
    const contact = await this.prisma.contact.findUnique({ where: { id: claimed.contact_id } });
    const vars = buildVars(contact);
    const subject = renderSubject(subjectTemplate, vars);

    // 追踪与退订：令牌里带 campaign / recipient / contact，点击目标 URL 也一起签名
    const payload = { c: campaign.id, r: claimed.id, k: claimed.contact_id };
    const html = renderHtml(template.html, vars, {
      rewriteLink: template.trackClick ? (url) => this.tracking.clickUrl(payload, url) : undefined,
      openPixelUrl: template.trackOpen ? this.tracking.pixelUrl(payload) : undefined,
    });
    const text = template.text?.trim() ? renderTextBody(template.text, vars) : htmlToText(html);
    const attachments = await this.loadAttachments(template);


    const result = await this.mail.send(channel.id, {
      to: claimed.email,
      subject,
      html,
      text,
      attachments,
    });

    if (result.ok) {
      await this.prisma.recipient.update({
        where: { id: claimed.id },
        data: {
          status: 'sent',
          channelId: channel.id,
          sentAt: new Date(),
          messageId: result.messageId ?? null,
          errorCode: null,
          errorMessage: null,
        },
      });
      this.lastSendByCampaign.set(campaign.id, Date.now());
      // 这一封发完，下一段的间隔重新抽一次
      this.gapByCampaign.delete(campaign.id);
      log.info(
        { recipientId: claimed.id, campaignId: campaign.id, channelId: channel.id, ms: result.elapsedMs },
        '投递成功',
      );
      await this.finishIfDone(campaign.id);
      return {
        action: 'sent',
        waitMs: this.computeWait(channel, campaign, selection.minIntervalSec),
        campaignId: campaign.id,
        email: claimed.email,
      };
    }

    // —— 失败处理：5xx 直接判死，绝不重试 ——
    const permanent = result.responseCode !== undefined && result.responseCode >= 500;
    if (permanent) {
      await this.failPermanently(claimed, result.message, `SMTP_${result.responseCode}`);
      log.warn(
        { recipientId: claimed.id, email: claimed.email, code: result.responseCode },
        '永久退信，已加入抑制名单',
      );
      await this.finishIfDone(campaign.id);
      return {
        action: 'failed',
        waitMs: this.computeWait(channel, campaign, selection.minIntervalSec),
        campaignId: campaign.id,
        email: claimed.email,
        detail: result.message,
      };
    }

    const nextAttempts = claimed.attempts + 1;
    if (nextAttempts > MAX_RETRIES) {
      await this.prisma.recipient.update({
        where: { id: claimed.id },
        data: {
          status: 'failed',
          attempts: nextAttempts,
          errorCode: result.code ?? 'RETRY_EXHAUSTED',
          errorMessage: `重试 ${MAX_RETRIES} 次仍失败：${result.message}`,
        },
      });
      log.warn({ recipientId: claimed.id, attempts: nextAttempts }, '重试次数耗尽');
      await this.finishIfDone(campaign.id);
      return {
        action: 'failed',
        waitMs: this.computeWait(channel, campaign, selection.minIntervalSec),
        campaignId: campaign.id,
        email: claimed.email,
        detail: result.message,
      };
    }

    const delaySec = RETRY_BACKOFF_SEC[nextAttempts - 1] ?? RETRY_BACKOFF_SEC[RETRY_BACKOFF_SEC.length - 1];
    await this.prisma.recipient.update({
      where: { id: claimed.id },
      data: {
        status: 'queued',
        attempts: nextAttempts,
        nextAttemptAt: new Date(Date.now() + delaySec * 1000),
        errorCode: result.code ?? `SMTP_${result.responseCode ?? 'NA'}`,
        errorMessage: result.message,
      },
    });
    log.info(
      { recipientId: claimed.id, attempts: nextAttempts, retryInSec: delaySec },
      '临时失败，已安排重试',
    );
    return {
      action: 'retry',
      waitMs: this.computeWait(channel, campaign, selection.minIntervalSec),
      campaignId: campaign.id,
      email: claimed.email,
      detail: result.message,
    };
  }

  /**
   * 原子取一封：FOR UPDATE SKIP LOCKED，多个 worker 也不会抢到同一封。
   *
   * ⚠️ 这里绝不能用 SQL 的 now()：recipients 的时间列是 timestamp without time zone，
   * 而 Prisma 按 UTC 写入。数据库会话时区是 Asia/Shanghai 时，now() 会被转成
   * 本地时间（+8）再和无时区的列比较，等于凭空多出 8 小时，任何退避时间都会失效，
   * 失败一次就能立刻被重新取走。所以一律传 JS 的 Date 参数，保证与写入口径一致。
   */
  private async claim(): Promise<ClaimedRow | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        SELECT r.id, r.campaign_id, r.contact_id, r.email, r.attempts, r.variant
        FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'queued'
          AND r.next_attempt_at <= ${now}
          AND c.status = 'running'
          AND c.deleted_at IS NULL
        ORDER BY r.id
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const row = rows[0];
      await tx.$executeRaw`
        UPDATE recipients SET status = 'sending', updated_at = ${now} WHERE id = ${row.id}
      `;
      return row;
    });
  }

  private async release(recipientId: number, delayMs: number) {
    await this.prisma.recipient.update({
      where: { id: recipientId },
      data: { status: 'queued', nextAttemptAt: new Date(Date.now() + delayMs) },
    });
  }

  /**
   * 永久失败：进抑制名单，以后任何任务都不会再发到这个地址。
   * 抑制是幂等的，重复写入不报错。
   */
  private async failPermanently(claimed: ClaimedRow, message: string, code: string) {
    await this.prisma.recipient.update({
      where: { id: claimed.id },
      data: {
        status: 'failed',
        attempts: claimed.attempts + 1,
        errorCode: code,
        errorMessage: message,
      },
    });
    await this.prisma.suppression
      .create({ data: { email: claimed.email, reason: 'bounce', note: `${code}: ${message.slice(0, 200)}` } })
      .catch(() => undefined);
  }

  /**
   * 选通道：状态正常、账号池今日还有配额、并且已经过了账号级发送间隔。
   *
   * 同一 SMTP 账号可能有多条通道（不同发信身份），它们共用一本账：
   * 配额、最近发送时间、最小间隔都必须按账号池判断，不能各算各的。
   * 同优先级下优先用今天发得少的账号，把额度摊平。
   */
  private async selectChannel(
    campaign: Campaign,
    day: string,
  ): Promise<{ channel: Channel | null; readyInMs: number; minIntervalSec: number }> {
    const all = await this.prisma.channel.findMany();
    const pools = groupAccounts(all, day);
    // 选择顺序：分组 > 指定通道 > 全部。
    // 分组是业务上的选择单位（一个账号下常有多条不同发信身份的通道），
    // 老任务没有分组，继续按 channelIds 走，不会因为这次改动失效。
    const scoped =
      campaign.channelGroupIds.length > 0
        ? all.filter((c) => c.groupIds.some((gid) => campaign.channelGroupIds.includes(gid)))
        : campaign.channelIds.length > 0
          ? all.filter((c) => campaign.channelIds.includes(c.id))
          : all;

    const now = Date.now();
    const usable: { c: Channel; pool: AccountPool<Channel>; used: number }[] = [];
    let earliest = Number.POSITIVE_INFINITY;

    for (const c of scoped) {
      if (c.status !== 'active') continue;
      const pool = pools.get(accountKey(c.host, c.username));
      if (!pool || pool.remaining <= 0) continue;

      const readyAt = pool.lastSentAt
        ? pool.lastSentAt.getTime() + pool.minIntervalSec * 1000
        : 0;
      if (readyAt > now) {
        earliest = Math.min(earliest, readyAt - now);
        continue;
      }
      usable.push({ c, pool, used: pool.used });
    }

    if (usable.length === 0) {
      return {
        channel: null,
        readyInMs: Number.isFinite(earliest) ? earliest : NO_CHANNEL_WAIT_MS,
        minIntervalSec: 0,
      };
    }

    usable.sort((a, b) => b.c.priority - a.c.priority || a.used - b.used || a.c.id - b.c.id);
    return { channel: usable[0].c, readyInMs: 0, minIntervalSec: usable[0].pool.minIntervalSec };
  }

  /** 账号间隔与任务间隔取严：两者都必须满足才能发下一封 */
  /**
   * 任务当前的发送间隔（毫秒）。
   * 只设了最小间隔就是固定间隔；设了最大间隔就在 [min, max] 里随机，
   * 让发送节奏看起来不像机器——固定间隔是最容易被服务商识别为批量群发的特征之一。
   */
  private gapFor(campaign: Campaign): number {
    const cached = this.gapByCampaign.get(campaign.id);
    if (cached !== undefined) return cached;

    const min = Math.max(1, campaign.sendIntervalSec);
    const max = campaign.sendIntervalMaxSec ?? min;
    const gapSec = max <= min ? min : min + Math.random() * (max - min);
    const gap = Math.round(gapSec * 1000);
    this.gapByCampaign.set(campaign.id, gap);
    return gap;
  }

  private computeWait(channel: Channel, campaign: Campaign, minIntervalSec: number): number {
    const now = Date.now();
    const channelWait = channel.lastSentAt
      ? channel.lastSentAt.getTime() + minIntervalSec * 1000 - now
      : 0;
    const lastCampaign = this.lastSendByCampaign.get(campaign.id) ?? 0;
    const campaignWait = lastCampaign ? lastCampaign + this.gapFor(campaign) - now : 0;
    return Math.min(Math.max(0, channelWait, campaignWait), MAX_SLEEP_MS);
  }

  /** 队列空了就把任务标记完成，避免停在 running 让人以为还在发 */
  private async finishIfDone(campaignId: number) {
    const remaining = await this.prisma.recipient.count({
      where: { campaignId, status: { in: ['queued', 'sending'] } },
    });
    if (remaining > 0) return;
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== 'running') return;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'done', finishedAt: new Date() },
    });
    log.info({ campaignId }, '任务已全部处理完成');
  }

  /**
   * 选出这一封该用哪份模板、哪个主题。
   *
   * 变体可能只改主题（模板不变），也可能整套换模板。
   * 变体引用的模板被删掉时退回任务主模板——一次误删不该让整批信全部判失败，
   * 那是最难解释的一种"事故"：明明模板还在，却全挂了。
   */
  private async resolveTemplate(
    campaign: Campaign,
    variantLabel: string | null,
  ): Promise<{ template: Template | null; subjectTemplate: string }> {
    let templateId = campaign.templateId;
    let subjectOverride: string | null = null;

    if (variantLabel) {
      const variant = await this.prisma.campaignVariant.findUnique({
        where: { campaignId_label: { campaignId: campaign.id, label: variantLabel } },
      });
      if (variant) {
        if (variant.subject) subjectOverride = variant.subject;
        if (variant.templateId) templateId = variant.templateId;
      }
    }

    let template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template && templateId !== campaign.templateId) {
      template = await this.prisma.template.findUnique({ where: { id: campaign.templateId } });
      log.warn(
        { campaignId: campaign.id, variantLabel, templateId },
        '变体模板已不存在，退回任务主模板',
      );
    }
    if (!template) return { template: null, subjectTemplate: '' };

    return { template, subjectTemplate: subjectOverride ?? template.subject };
  }

  private async loadAttachments(template: Template): Promise<OutgoingAttachment[]> {
    if (!template.attachmentIds?.length) return [];
    const rows = await this.prisma.attachment.findMany({ where: { id: { in: template.attachmentIds } } });
    return rows.map((a) => ({ filename: a.filename, path: a.path, contentType: a.mime }));
  }
}
