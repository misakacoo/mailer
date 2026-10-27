import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config';
import { log } from '../common/logger';
import { PrismaService } from '../common/prisma.service';
import { calendarDay, dayToDbDate, isSameCalendarDay } from '../common/quota';
import { buildTransporter, credentialFromChannel, smtpErrorText } from '../common/smtp';

/** 连续失败多少次自动停用通道。与「测试发信」路径保持同一阈值。 */
const FAILURE_THRESHOLD = 3;

/**
 * 区分「账号/链路故障」和「这一个收件人的问题」。
 *
 * 只有前者才该计入熔断：一批地址全是 550 user unknown 或 452 mailbox full 时，
 * 账号本身是健康的，按失败次数停用它等于让坏数据把好账号拖死。
 * 后者已经落在 recipients.error_code 和失败报表里，不需要通道层再喊一遍。
 */
function isChannelFailure(e: any): boolean {
  const code = e?.code ? String(e.code) : '';
  if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET'].includes(code)) return true;
  const rc = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  // 421 = 服务端主动断开；530/535 = 认证被拒，这三类都属于账号层
  return rc === 421 || rc === 530 || rc === 535;
}

export interface OutgoingAttachment {
  filename: string;
  path: string;
  contentType?: string;
}

export interface SendMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: OutgoingAttachment[];
  /** 额外邮件头，例如 List-Unsubscribe / List-Unsubscribe-Post */
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  response?: string;
  accepted?: string[];
  rejected?: string[];
  /** nodemailer 的错误码，如 EAUTH / ETIMEDOUT / EENVELOPE */
  code?: string;
  /** SMTP 响应码，4xx 临时失败、5xx 永久失败；超时类错误没有响应码 */
  responseCode?: number;
  elapsedMs: number;
  message: string;
}

@Injectable()
export class MailService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * 经指定通道发一封信。
   * 返回诊断结果而不是抛异常：调用方（测试发送、任务发送）都要把失败原因原样展示给用户。
   */
  async send(channelId: number, msg: SendMessage): Promise<SendResult> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('通道不存在');

    const started = Date.now();
    const transporter = buildTransporter(credentialFromChannel(channel, this.cfg.credKey));

    try {
      const info = await transporter.sendMail({
        from: channel.fromName
          ? { name: channel.fromName, address: channel.fromEmail }
          : channel.fromEmail,
        to: msg.to,
        replyTo: channel.replyTo ?? undefined,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments,
        headers: msg.headers,
      });

      await this.recordSend(channelId);

      return {
        ok: true,
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted as string[],
        rejected: info.rejected as string[],
        elapsedMs: Date.now() - started,
        message: `已投递到 ${(info.accepted ?? []).join(', ') || msg.to}`,
      };
    } catch (e: any) {
      const text = smtpErrorText(e);
      if (isChannelFailure(e)) await this.markFailure(channelId, text);
      return {
        ok: false,
        code: e?.code ? String(e.code) : undefined,
        responseCode: typeof e?.responseCode === 'number' ? e.responseCode : undefined,
        elapsedMs: Date.now() - started,
        message: text,
      };
    } finally {
      transporter.close();
    }
  }

  /**
   * 发一封就记一封：测试发送也消耗服务商的真实额度。
   *
   * 成功即视为账号可用：清零连续失败计数；如果之前被自动停用，顺带恢复成 active。
   * 只恢复 error 状态，手工 paused 的不动——那是人的决定，不该被一封成功信推翻。
   */
  private async recordSend(channelId: number) {
    const day = calendarDay();
    try {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.channel.findUnique({ where: { id: channelId } });
        if (!c) return;
        const revive = c.status === 'error' ? { status: 'active' } : {};
        if (!isSameCalendarDay(c.quotaDate, day)) {
          await tx.channel.update({
            where: { id: channelId },
            data: {
              sentToday: 1,
              quotaDate: dayToDbDate(day),
              lastSentAt: new Date(),
              lastOkAt: new Date(),
              consecutiveFailures: 0,
              ...revive,
            },
          });
        } else {
          await tx.channel.update({
            where: { id: channelId },
            data: {
              sentToday: { increment: 1 },
              lastSentAt: new Date(),
              lastOkAt: new Date(),
              consecutiveFailures: 0,
              ...revive,
            },
          });
        }
      });
    } catch {
      // 计数失败不应影响"邮件已发出"这个事实
    }
  }

  /**
   * 失败记账 + 自动熔断。
   *
   * 为什么必须做：一个密码失效或已被服务商风控的账号，在 SMTP 阶段对每一封都报错。
   * 如果不熔断，任务会把整个队列逐封重试三次再判失败——几十封的额度白烧，
   * 面板上账号却一直显示 active，看起来"只是运气不好"。
   */
  private async markFailure(channelId: number, message: string) {
    try {
      const updated = await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          lastError: message,
          lastErrorAt: new Date(),
          consecutiveFailures: { increment: 1 },
        },
      });

      if (updated.status === 'active' && updated.consecutiveFailures >= FAILURE_THRESHOLD) {
        await this.prisma.channel.update({ where: { id: channelId }, data: { status: 'error' } });
        log.warn(
          { channelId, failures: updated.consecutiveFailures },
          '连续失败达到阈值，通道已自动停用',
        );
      }
    } catch {
      // 通道可能已被删除，记账失败不影响本次结果
    }
  }
}
