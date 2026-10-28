import { Inject, Injectable } from '@nestjs/common';
import { Campaign, Channel, Recipient, Template } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';
import { calendarDay } from '../common/quota';
import { MailService, OutgoingAttachment } from '../mail/mail.service';
import { buildVars, htmlToText, renderHtml, renderSubject, renderTextBody } from '../templates/render';
import { TrackingService } from '../tracking/tracking.service';
import { log } from '../common/logger';
import { isAddressMissing } from '../common/address-missing';
import { ListsService } from '../lists/lists.service';
import { isSameCalendarDay } from '../common/quota';

/** 4xx 临时失败的重试间隔：1 分钟 / 5 分钟 / 30 分钟 */
const RETRY_BACKOFF_SEC = [60, 300, 1800];
/** 重试次数上限（不含首次发送） */
const MAX_RETRIES = 3;

const IDLE_WAIT_MS = 3000;
const NO_CHANNEL_WAIT_MS = 10000;
const MAX_SLEEP_MS = 20000;
/** 发送租约：取件时写入，到期未完成才允许回收。比"按 updatedAt 盲扫"安全得多 */
const LEASE_MS = 5 * 60 * 1000;
/** 老数据可能没有 lease_until，仍按这个时间兜底判断 */
const STALE_SENDING_MS = 10 * 60 * 1000;

export interface ClaimedRow {
  id: number;
  campaign_id: number;
  /** 联系人可能已被删除（历史明细仍然要能继续发/落失败） */
  contact_id: number | null;
  email: string;
  attempts: number;
  /** A/B 变体标签，未启用 A/B 的任务为空 */
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
    private readonly lists: ListsService,
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
    const now = new Date();
    const cutoff = new Date(Date.now() - STALE_SENDING_MS);
    const res = await this.prisma.recipient.updateMany({
      where: {
        status: 'sending',
        // 有租约按租约判，没有租约的老行退回按时间戳判
        OR: [{ leaseUntil: { lt: now } }, { leaseUntil: null, updatedAt: { lt: cutoff } }],
      },
      data: { status: 'queued', nextAttemptAt: now, leaseUntil: null },
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
    const { template, subjectTemplate } = await this.resolveTemplate(campaign);
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
    const contact = claimed.contact_id
      ? await this.prisma.contact.findUnique({ where: { id: claimed.contact_id } })
      : null;
    const vars = buildVars(contact);
    const subject = renderSubject(subjectTemplate, vars);

    let result: Awaited<ReturnType<MailService['send']>>;
    try {
      // 追踪与退订：令牌里带 campaign / recipient / contact，点击目标 URL 也一起签名
      const payload = { c: campaign.id, r: claimed.id, k: claimed.contact_id ?? 0 };
      const html = renderHtml(template.html, vars, {
        rewriteLink: template.trackClick ? (url) => this.tracking.clickUrl(payload, url) : undefined,
        openPixelUrl: template.trackOpen ? this.tracking.pixelUrl(payload) : undefined,
      });
      const text = template.text?.trim() ? renderTextBody(template.text, vars) : htmlToText(html);
      const attachments = await this.loadAttachments(template);

      result = await this.mail.send(channel.id, {
        to: claimed.email,
        subject,
        html,
        text,
        attachments,
      });
    } catch (e: any) {
      // 渲染、附件读取、凭据解密都会在这里抛。以前没有这层 try，
      // 一旦抛出这一行就永远卡在 sending、attempts 也不增加，任务无限空转。
      await this.recordSendException(claimed, campaign.id, e);
      return {
        action: 'retry',
        waitMs: Math.max(1000, this.computeWait(campaign)),
        campaignId: campaign.id,
        email: claimed.email,
        detail: e?.message ?? String(e),
      };
    }

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
          leaseUntil: null,
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
        waitMs: this.computeWait(campaign),
        campaignId: campaign.id,
        email: claimed.email,
      };
    }

    if (!result.ok && result.code === 'QUOTA_EXCEEDED') {
      // 选通道时还有额度、真正扣减时被别人抢先了。这条要放回队列等明天，
      // 按临时失败处理会把重试次数白白烧光。
      await this.release(claimed.id, 60_000);
      return { action: 'no-channel', waitMs: 60_000, campaignId: campaign.id };
    }

    // —— 失败处理：5xx 是永久性的，不再重试；但只有"地址不存在"才拉黑 ——
    const permanent = result.responseCode !== undefined && result.responseCode >= 500;
    if (permanent) {
      const missing = isAddressMissing(result.message);
      if (missing) {
        await this.failPermanently(claimed, result.message, `SMTP_${result.responseCode}`);
        log.warn(
          { recipientId: claimed.id, email: claimed.email, code: result.responseCode },
          '地址不存在，已加入抑制名单',
        );
        await this.lists.moveToUndeliverable(claimed.email).catch((e) => {
          log.warn({ email: claimed.email, err: String(e) }, '移入「地址不存在」分组失败');
        });
      } else {
        // 535 认证失败、552 邮箱已满、554 策略拒收：地址本身有效，拉黑会误伤真实收件人
        await this.markFailed(claimed, `SMTP_${result.responseCode}`, result.message);
        log.warn(
          { recipientId: claimed.id, code: result.responseCode, message: result.message },
          '通道或策略拒收，本条判失败但地址不拉黑',
        );
      }
      await this.finishIfDone(campaign.id);
      return {
        action: 'failed',
        waitMs: this.computeWait(campaign),
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
        waitMs: this.computeWait(campaign),
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
      waitMs: this.computeWait(campaign),
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
        SELECT r.id, r.campaign_id, r.contact_id, r.email, r.attempts
        FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'queued'
          AND r.next_attempt_at <= ${now}
          AND c.status = 'running'
          AND c.deleted_at IS NULL
          -- 抑制名单可能在排队之后才增加，取件时必须再拦一次
          AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = r.email)
        -- 与 (status, next_attempt_at) 索引同序，避免每封都对全部到期行排序
        ORDER BY r.next_attempt_at, r.id
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const row = rows[0];
      const lease = new Date(now.getTime() + LEASE_MS);
      await tx.$executeRaw`
        UPDATE recipients
        SET status = 'sending', lease_until = ${lease}, updated_at = ${now}
        WHERE id = ${row.id}
      `;
      return row;
    });
  }

  private async release(recipientId: number, delayMs: number) {
    // 只回滚还处于 sending 的行：任务被取消时它已经是 canceled，
    // 无条件 update 会把"已取消"改回"待发送"，进度条永远到不了 100%
    await this.prisma.recipient.updateMany({
      where: { id: recipientId, status: 'sending' },
      data: { status: 'queued', nextAttemptAt: new Date(Date.now() + delayMs), leaseUntil: null },
    });
  }

  /** 通道/策略层面的永久失败：这条明细判死，但不动抑制名单 */
  private async markFailed(claimed: ClaimedRow, code: string, message: string) {
    await this.prisma.recipient.updateMany({
      where: { id: claimed.id, status: 'sending' },
      data: {
        status: 'failed',
        attempts: claimed.attempts + 1,
        errorCode: code,
        errorMessage: message.slice(0, 500),
        leaseUntil: null,
      },
    });
  }

  /**
   * 渲染/附件/凭据解密抛异常时的兜底。
   * 关键点是：无论什么异常，这一行都不能留在 sending，且 attempts 必须推进一次，
   * 否则它会每 5 分钟被回收、再卡住，任务永远结束不了。
   */
  private async recordSendException(claimed: ClaimedRow, campaignId: number, e: any) {
    const nextAttempts = claimed.attempts + 1;
    const exhausted = nextAttempts > MAX_RETRIES;
    const delaySec = RETRY_BACKOFF_SEC[nextAttempts - 1] ?? RETRY_BACKOFF_SEC[RETRY_BACKOFF_SEC.length - 1];
    const res = await this.prisma.recipient.updateMany({
      where: { id: claimed.id, status: 'sending' },
      data: {
        status: exhausted ? 'failed' : 'queued',
        attempts: nextAttempts,
        nextAttemptAt: new Date(Date.now() + (exhausted ? 0 : delaySec * 1000)),
        leaseUntil: null,
        errorCode: 'SEND_EXCEPTION',
        errorMessage: String(e?.message ?? e).slice(0, 500),
      },
    });
    log.error(
      { recipientId: claimed.id, campaignId, attempts: nextAttempts, err: String(e?.message ?? e) },
      '发送流程异常，已记账',
    );
    if (exhausted && res.count > 0) await this.finishIfDone(campaignId);
  }

  /**
   * 永久失败：进抑制名单，以后任何任务都不会再发到这个地址。
   * 抑制是幂等的，重复写入不报错。
   */
  private async failPermanently(claimed: ClaimedRow, message: string, code: string) {
    // 地址确实不可用，抑制照写；但只有还处于 sending 的明细才改状态，
    // 避免把用户刚取消的那一行从 canceled 改成 failed
    await this.prisma.recipient.updateMany({
      where: { id: claimed.id, status: 'sending' },
      data: {
        status: 'failed',
        attempts: claimed.attempts + 1,
        errorCode: code,
        errorMessage: message,
        leaseUntil: null,
      },
    });
    await this.prisma.suppression
      .create({ data: { email: claimed.email, reason: 'bounce', note: `${code}: ${message.slice(0, 200)}` } })
      .catch(() => undefined);
  }

  /**
   * 选通道：状态正常、账号池今日还有配额。
   *
   * 同一 SMTP 账号可能有多条通道（不同发信身份），它们共用一本账：
   * 每条记录就是一个发件邮箱，配额按它自己的已发数判断。
   * 发送节奏由任务的间隔设置决定，这里没有发件邮箱级的间隔约束。
   * 同优先级下优先用今天发得少的账号，把额度摊平。
   */
  private async selectChannel(
    campaign: Campaign,
    day: string,
  ): Promise<{ channel: Channel | null; readyInMs: number }> {
    const all = await this.prisma.channel.findMany();
    // 选择顺序：分组 > 指定记录 > 全部。
    // 分组是业务上的选择单位（一个账号下常有多条不同发信身份的通道），
    // 老任务没有分组，继续按 channelIds 走，不会因为这次改动失效。
    const scoped =
      campaign.channelGroupIds.length > 0
        ? all.filter((c) => c.groupIds.some((gid) => campaign.channelGroupIds.includes(gid)))
        : campaign.channelIds.length > 0
          ? all.filter((c) => campaign.channelIds.includes(c.id))
          : all;

    // 配额按"真实账号"算：同一 host+username 下的多条发信身份共用服务商额度，
    // 组内已发数相加才是账号今天真实用量。取组内最小正限额作为账号上限。
    const accountUsed = new Map<string, number>();
    const accountLimit = new Map<string, number>();
    for (const c of all) {
      const key = `${c.host}|${c.username}`;
      const used = isSameCalendarDay(c.quotaDate, day) ? Math.max(0, c.sentToday) : 0;
      accountUsed.set(key, (accountUsed.get(key) ?? 0) + used);
      const limit = c.dailyLimit > 0 ? c.dailyLimit : 0;
      const prev = accountLimit.get(key) ?? 0;
      accountLimit.set(key, prev === 0 ? limit : limit === 0 ? prev : Math.min(prev, limit));
    }

    const usable: { c: Channel; used: number }[] = [];

    for (const c of scoped) {
      if (c.status !== 'active') continue;
      const key = `${c.host}|${c.username}`;
      const limit = accountLimit.get(key) ?? 0;
      const usedByAccount = accountUsed.get(key) ?? 0;
      if (limit > 0 && usedByAccount >= limit) continue;
      usable.push({
        c,
        used: isSameCalendarDay(c.quotaDate, day) ? Math.max(0, c.sentToday) : 0,
      });
    }

    if (usable.length === 0) {
      return { channel: null, readyInMs: NO_CHANNEL_WAIT_MS };
    }

    usable.sort((a, b) => b.c.priority - a.c.priority || a.used - b.used || a.c.id - b.c.id);
    return { channel: usable[0].c, readyInMs: 0 };
  }

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

  private computeWait(campaign: Campaign): number {
    const now = Date.now();
    const lastCampaign = this.lastSendByCampaign.get(campaign.id) ?? 0;
    const campaignWait = lastCampaign ? lastCampaign + this.gapFor(campaign) - now : 0;
    return Math.min(Math.max(0, campaignWait), MAX_SLEEP_MS);
  }

  /** 队列空了就把任务标记完成，避免停在 running 让人以为还在发 */
  private async finishIfDone(campaignId: number) {
    // 只看"还有没有"，不用数全量：EXISTS 命中即停，比 count 便宜一个数量级
    const pending = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM recipients
      WHERE campaign_id = ${campaignId} AND status IN ('queued', 'sending')
      LIMIT 1
    `;
    if (pending.length > 0) return;
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== 'running') return;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'done', finishedAt: new Date() },
      select: { id: true },
    });
    this.lastSendByCampaign.delete(campaignId);
    this.gapByCampaign.delete(campaignId);
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
  ): Promise<{ template: Template | null; subjectTemplate: string }> {
    const template = await this.prisma.template.findUnique({ where: { id: campaign.templateId } });
    if (!template) return { template: null, subjectTemplate: '' };
    return { template, subjectTemplate: template.subject };
  }

  private async loadAttachments(template: Template): Promise<OutgoingAttachment[]> {
    if (!template.attachmentIds?.length) return [];
    const rows = await this.prisma.attachment.findMany({ where: { id: { in: template.attachmentIds } } });
    return rows.map((a) => ({ filename: a.filename, path: a.path, contentType: a.mime }));
  }
}
