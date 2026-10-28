import { Inject, Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { APP_CONFIG, AppConfig } from '../common/config';
import { log } from '../common/logger';
import { PrismaService } from '../common/prisma.service';
import { credentialFromChannel } from '../common/smtp';
import { isAddressMissing } from '../common/address-missing';
import { ListsService } from '../lists/lists.service';

interface BounceHit {
  email: string;
  status: string;
  diagnostic: string;
}

/** 只回看最近这么多天的退信，避免把整箱历史未读全拉下来解析 */
const LOOKBACK_DAYS = 30;

/** IMAP 的很多调用在连接异常时不会 resolve，必须加超时，否则会把事件循环挂死 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]).catch(() => undefined) as Promise<T | void>;
}

/**
 * 退信解析。
 *
 * 为什么必须有：Hostinger 这类服务商在 SMTP 阶段一律回 250，
 * 无效地址是事后异步退回的。没有这一步，死地址会被标记"已送达"、
 * 永远不进抑制名单，群发会持续往死地址上撞，拖垮账号信誉。
 *
 * 设计取舍：
 * - 只处理 5.x.x（永久失败）。4.x.x 是临时失败，服务商自己还会重试，我们不动。
 * - 只处理未读邮件，解析成功才标记已读——不碰用户真实往来的邮件。
 * - 不依赖 DSN 的 MIME 结构，直接按 RFC 3464 的字段名从原文里抓，
 *   各家服务商的 DSN 结构差异很大，字段名反而稳定。
 */
@Injectable()
export class BounceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly lists: ListsService,
  ) {}

  /** 从 smtp.xxx.com 推导 imap.xxx.com，推导不出来就跳过这条通道 */
  private imapHostOf(smtpHost: string): string | null {
    if (!/^smtp\./i.test(smtpHost)) return null;
    return smtpHost.replace(/^smtp\./i, 'imap.');
  }

  async pollAll(): Promise<{ channels: number; processed: number; suppressed: number; errors: number }> {
    const channels = await this.prisma.channel.findMany({ where: { status: 'active' } });
    let processed = 0;
    let suppressed = 0;
    let errors = 0;

    for (const channel of channels) {
      const host = this.imapHostOf(channel.host);
      if (!host) continue;

      let client: ImapFlow | null = null;
      try {
        const cred = credentialFromChannel(channel, this.cfg.credKey);
        client = new ImapFlow({
          host,
          port: 993,
          secure: true,
          auth: { user: cred.username, pass: cred.password },
          logger: false,
          socketTimeout: 20000,
          greetingTimeout: 15000,
        });

        // imapflow 在 socket 超时 / TLS 中断时会 emit('error')。
        // EventEmitter 的 'error' 事件没有监听者时，Node 会直接抛出并终止进程——
        // 这正是之前 worker 每几十秒重启一次的原因（日志里只有 exit-code，看不到堆栈）。
        // 这里必须挂一个监听器把它降级成一条告警日志。
        client.on('error', (e: any) => {
          log.warn(
            { channelId: channel.id, host, err: e?.message ?? String(e) },
            'IMAP 连接异常（已忽略，本轮跳过该通道）',
          );
        });

        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          const mailbox = client.mailbox;
          if (!mailbox || typeof mailbox === 'boolean') continue;

          const uidValidity = mailbox.uidValidity ?? 0n;
          // 去重表：Hostinger 这类 IMAP 在连续操作后容易 socket 超时，
          // 「标记已读」一旦失败，只靠 \Seen 搜索就会每轮把同一批 DSN 重跑一遍。
          const seenRows = await this.prisma.bounceSeen.findMany({
            where: { channelId: channel.id, uidValidity },
            select: { uid: true },
          });
          const seen = new Set(seenRows.map((r) => r.uid));
          const handled: number[] = [];
          // 只回看 30 天，避免把整箱历史未读都拉下来解析
          const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

          for await (const msg of client.fetch({ seen: false, since }, { source: true, uid: true })) {
            if (seen.has(msg.uid)) continue;
            const source = msg.source?.toString('utf8') ?? '';
            const hits = this.parseDsn(source);
            if (hits.length === 0) continue;

            processed++;
            for (const hit of hits) {
              if (!hit.status.startsWith('5.')) continue;
              const ok = await this.markBounced(hit, channel.id);
              if (ok) suppressed++;
            }
            handled.push(msg.uid);
          }

          if (handled.length > 0) {
            // 批量标记，一次往返而不是每封一次；失败也不影响去重表兜底
            await withTimeout(
              client.messageFlagsAdd(handled.join(','), ['\\Seen'], { uid: true }),
              10000,
            );
            await this.prisma.bounceSeen.createMany({
              data: handled.map((uid) => ({ channelId: channel.id, uidValidity, uid })),
              skipDuplicates: true,
            });
          }
        } finally {
          lock.release();
        }

        await withTimeout(client.logout(), 5000);
      } catch (e: any) {
        errors++;
        log.warn({ channelId: channel.id, host, err: e?.message ?? String(e) }, '退信解析失败，跳过本条通道');
      } finally {
        // imapflow 的 close() 返回 void，不能链 .catch，只能整体 try
        try {
          client?.close();
        } catch {
          // 连接可能已经断了，忽略
        }
      }
    }

    if (processed > 0) log.info({ processed, suppressed }, '退信解析完成');

    // 去重记录只保留与回看窗口同样长的时间，过期即清
    await this.prisma.bounceSeen
      .deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) } },
      })
      .catch(() => undefined);

    return { channels: channels.length, processed, suppressed, errors };
  }

  /** 从 DSN 原文里抽 Final-Recipient + Status 组合 */
  private parseDsn(source: string): BounceHit[] {
    if (!/Final-Recipient:/i.test(source) || !/Status:/i.test(source)) return [];

    const hits: BounceHit[] = [];
    const idxs: number[] = [];
    const re = /Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      idxs.push(m.index);
      hits.push({ email: m[1].trim().toLowerCase(), status: '', diagnostic: '' });
    }

    for (let i = 0; i < hits.length; i++) {
      const start = idxs[i];
      const end = i + 1 < idxs.length ? idxs[i + 1] : Math.min(source.length, start + 4000);
      const block = source.slice(start, end);

      const status = block.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i);
      if (status) hits[i].status = status[1];

      const diag =
        block.match(/Diagnostic-Code:\s*smtp;\s*([^\r\n]+)/i) ??
        block.match(/Diagnostic-Code:\s*([^\r\n]+)/i);
      if (diag) hits[i].diagnostic = diag[1].trim().slice(0, 300);
    }

    return hits.filter((h) => h.email && h.status);
  }

  /**
   * 把退信落到数据上：
   * - 最近一条"已送达"的投递记录改判为 failed
   * - 地址写入抑制名单（永久，不再发送）
   */
  private async markBounced(hit: BounceHit, channelId: number): Promise<boolean> {
    // 退信是从这个通道的收件箱里拿到的，只该影响这个通道发出去的那一次投递。
    // 不加 channelId 会误伤同一地址在别的通道/任务里的正常投递。
    const recipient = await this.prisma.recipient.findFirst({
      where: { email: hit.email, status: 'sent', channelId },
      orderBy: { id: 'desc' },
    });

    if (recipient) {
      await this.prisma.recipient.update({
        where: { id: recipient.id },
        data: {
          status: 'failed',
          errorCode: `BOUNCE_${hit.status}`,
          errorMessage: hit.diagnostic || `退信：${hit.status}`,
        },
      });
      // 该任务如果因此变成"全部处理完"，补一次完成判定
      await this.finishIfDone(recipient.campaignId);
    }

    await this.prisma.suppression
      .createMany({
        data: [
          {
            email: hit.email,
            reason: 'bounce',
            note: `${hit.status} ${hit.diagnostic}`.trim().slice(0, 300),
          },
        ],
        // 用 createMany + skipDuplicates，而不是 create().catch()：
        // 后者虽然被吞掉了，但 Prisma 仍会往日志里打一条 error，长期看会淹没真正的故障
        skipDuplicates: true,
      })
      .catch(() => undefined);

    log.warn({ email: hit.email, status: hit.status, channelId }, '已处理退信并加入抑制名单');

    // 只把"地址不存在"这类挪进分组：策略拒收、邮箱已满的地址本身是有效的
    if (isAddressMissing(hit.diagnostic)) {
      await this.lists.moveToUndeliverable(hit.email).catch((e) => {
        log.warn({ email: hit.email, err: String(e) }, '移入「地址不存在」分组失败');
      });
    }
    return true;
  }

  private async finishIfDone(campaignId: number) {
    const remaining = await this.prisma.recipient.count({
      where: { campaignId, status: { in: ['queued', 'sending'] } },
    });
    if (remaining > 0) return;
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c || c.status !== 'running') return;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'done', finishedAt: new Date() },
    });
  }
}
