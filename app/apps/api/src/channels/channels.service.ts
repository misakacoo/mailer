import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Channel, Prisma } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../common/config';
import { encryptSecret } from '../common/crypto';
import { PrismaService } from '../common/prisma.service';
import { BUSINESS_TZ, calendarDay, dayToDbDate, isSameCalendarDay } from '../common/quota';
import {
  SmtpCredential,
  buildTransporter,
  credentialFromChannel as credentialFromChannelUtil,
  smtpErrorText,
} from '../common/smtp';
import { CreateChannelDto, TestConnectionDto, UpdateChannelDto } from './dto/channel.dto';
import { SMTP_PRESETS } from './presets';

export interface PublicChannel {
  id: number;
  groupIds: number[];
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string | null;
  fromEmail: string;
  replyTo: string | null;
  dailyLimit: number;
  sentToday: number;
  remaining: number;
  priority: number;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
  lastSentAt: string | null;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  presets() {
    return SMTP_PRESETS;
  }

  async list(): Promise<PublicChannel[]> {
    const day = calendarDay();
    await this.resetQuotas(day);
    const rows = await this.prisma.channel.findMany({
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
    });
    return rows.map((c) => this.toPublic(c, day));
  }

  async create(dto: CreateChannelDto): Promise<PublicChannel> {
    const day = calendarDay();
    const created = await this.prisma.channel.create({
      data: {
        host: dto.host.trim(),
        port: dto.port,
        secure: dto.secure,
        username: dto.username.trim(),
        passwordEnc: encryptSecret(dto.password, this.cfg.credKey),
        fromName: dto.fromName?.trim() || null,
        fromEmail: dto.fromEmail.trim().toLowerCase(),
        replyTo: dto.replyTo?.trim().toLowerCase() || null,
        dailyLimit: dto.dailyLimit ?? this.cfg.defaultDailyLimit,
        priority: dto.priority ?? 0,
        groupIds: dto.groupIds ?? [],
        quotaDate: dayToDbDate(day),
      },
    });
    return this.toPublic(created, day);
  }

  async update(id: number, dto: UpdateChannelDto): Promise<PublicChannel> {
    const day = calendarDay();
    await this.getOrThrow(id);

    // 一条记录就是一个发件邮箱：改哪条只影响哪条，不再向"同账号其他记录"同步。
    const data: Prisma.ChannelUncheckedUpdateInput = {};
    if (dto.host !== undefined) data.host = dto.host.trim();
    if (dto.port !== undefined) data.port = dto.port;
    if (dto.secure !== undefined) data.secure = dto.secure;
    if (dto.username !== undefined) data.username = dto.username.trim();
    if (dto.dailyLimit !== undefined) data.dailyLimit = dto.dailyLimit;
    if (dto.fromName !== undefined) data.fromName = dto.fromName?.trim() || null;
    if (dto.fromEmail !== undefined) data.fromEmail = dto.fromEmail.trim().toLowerCase();
    if (dto.replyTo !== undefined) data.replyTo = dto.replyTo?.trim().toLowerCase() || null;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.groupIds !== undefined) data.groupIds = dto.groupIds;
    if (dto.status !== undefined && ['active', 'paused', 'error'].includes(dto.status)) {
      data.status = dto.status;
    }

    // 密码留空表示不修改：前端编辑时拿不到明文，也就无法原样回传
    const newPassword = dto.password !== undefined && dto.password !== '' ? dto.password : null;
    if (newPassword) {
      data.passwordEnc = encryptSecret(newPassword, this.cfg.credKey);
      data.consecutiveFailures = 0;
      data.lastError = null;
      if (dto.status === undefined) data.status = 'active';
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.channel.update({ where: { id }, data });
    }

    const updated = await this.getOrThrow(id);
    return this.toPublic(updated, day);
  }

  async remove(id: number): Promise<{ ok: true }> {
    await this.getOrThrow(id);
    // 投递记录里的发件邮箱是外键（onDelete: SetNull），历史保留、指向置空
    await this.prisma.channel.delete({ where: { id } });
    return { ok: true };
  }

  async duplicate(id: number): Promise<PublicChannel> {
    const day = calendarDay();
    const src = await this.getOrThrow(id);
    // 不能直接复用原密文：相同明文应使用新的 IV 重新加密，
    // 否则两条记录的 password_enc 完全一致，能从密文看出它们用了同一个密码。
    const plainPassword = this.credentialFromChannel(src).password;
    const created = await this.prisma.channel.create({
      data: {
        host: src.host,
        port: src.port,
        secure: src.secure,
        username: src.username,
        passwordEnc: encryptSecret(plainPassword, this.cfg.credKey),
        fromName: src.fromName,
        fromEmail: src.fromEmail,
        replyTo: src.replyTo,
        dailyLimit: src.dailyLimit,
        priority: src.priority,
        status: 'active',
        // 新记录从 0 开始计数，不继承已用额度
        sentToday: 0,
        quotaDate: dayToDbDate(day),
      },
    });
    return this.toPublic(created, day);
  }

  /** 测试连接：返回诊断结果而不是抛错，前端直接展示原因 */
  async testConnection(dto: TestConnectionDto) {
    const cred = await this.resolveCredential(dto);
    const started = Date.now();
    const transporter = buildTransporter(cred);

    try {
      await transporter.verify();
      const elapsedMs = Date.now() - started;

      if (dto.id) {
        const current = await this.getOrThrow(dto.id).catch(() => null);
        await this.prisma.channel.update({
          where: { id: dto.id },
          data: {
            lastOkAt: new Date(),
            consecutiveFailures: 0,
            lastError: null,
            // 只在之前是异常状态时才恢复，避免把手工停用的通道悄悄启用
            ...(current?.status === 'error' ? { status: 'active' } : {}),
          },
        });
      }

      return { ok: true, elapsedMs, message: `连接成功，认证通过（${elapsedMs}ms）` };
    } catch (e: any) {
      const message = smtpErrorText(e);
      if (dto.id) {
        await this.prisma.channel
          .update({
            where: { id: dto.id },
            data: {
              lastError: message,
              lastErrorAt: new Date(),
              consecutiveFailures: { increment: 1 },
              status: 'error',
            },
          })
          .catch(() => undefined);
      }
      return { ok: false, elapsedMs: Date.now() - started, message };
    } finally {
      transporter.close();
    }
  }

  async testSend(id: number, to: string) {
    const channel = await this.getOrThrow(id);
    const day = calendarDay();
    const used = isSameCalendarDay(channel.quotaDate, day) ? Math.max(0, channel.sentToday) : 0;
    if (channel.dailyLimit > 0 && used >= channel.dailyLimit) {
      throw new BadRequestException(
        `该发件邮箱今日配额已用完（${used}/${channel.dailyLimit}），测试信也会消耗服务商真实额度，请明天再试`,
      );
    }
    const cred = this.credentialFromChannel(channel);
    const started = Date.now();
    const transporter = buildTransporter(cred);

    const now = new Date().toLocaleString('zh-CN', { timeZone: BUSINESS_TZ });
    const subject = `[通道测试] ${channel.fromEmail} · ${now}`;
    const text = [
      '这是一封来自邮件营销系统的通道测试邮件。',
      '',
      `发信地址：${channel.fromEmail}`,
      `SMTP：${channel.host}:${channel.port}（${channel.secure ? 'SSL/TLS' : 'STARTTLS'}）`,
      `发信地址：${channel.fromEmail}`,
      `发送时间：${now}`,
      '',
      '如果你看到这封邮件，说明这条通道的认证与投递都正常。',
    ].join('\n');

    const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#1f2328">
  <p><b>通道测试通过</b></p>
  <p>这是一封来自邮件营销系统的通道测试邮件。</p>
  <table cellpadding="6" style="border-collapse:collapse;font-size:13px">
    <tr><td style="color:#6b7280">发信地址</td><td>${escapeHtml(channel.fromEmail)}</td></tr>
    <tr><td style="color:#6b7280">SMTP</td><td>${escapeHtml(channel.host)}:${channel.port}（${channel.secure ? 'SSL/TLS' : 'STARTTLS'}）</td></tr>
    <tr><td style="color:#6b7280">发信地址</td><td>${escapeHtml(channel.fromEmail)}</td></tr>
    <tr><td style="color:#6b7280">发送时间</td><td>${escapeHtml(now)}</td></tr>
  </table>
  <p style="color:#6b7280;font-size:12px">如果这封邮件进入了垃圾箱，说明该账号在新收件方那里的信誉还不够，正式群发前需要先做投递验证。</p>
</div>`;

    try {
      const info = await transporter.sendMail({
        from: channel.fromName
          ? { name: channel.fromName, address: channel.fromEmail }
          : channel.fromEmail,
        to,
        replyTo: channel.replyTo ?? undefined,
        subject,
        text,
        html,
        headers: { 'X-Mailer-Test': 'channel-test' },
      });

      await this.prisma.channel.update({
        where: { id },
        data: { lastSentAt: new Date(), lastOkAt: new Date(), lastError: null, consecutiveFailures: 0 },
      });
      await this.consumeQuota(id);

      return {
        ok: true,
        elapsedMs: Date.now() - started,
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
        message: `已投递到 ${(info.accepted ?? []).join(', ') || to}`,
      };
    } catch (e: any) {
      const message = smtpErrorText(e);
      await this.prisma.channel
        .update({
          where: { id },
          data: {
            lastError: message,
            lastErrorAt: new Date(),
            consecutiveFailures: { increment: 1 },
            ...(channel.consecutiveFailures + 1 >= 3 ? { status: 'error' } : {}),
          },
        })
        .catch(() => undefined);
      return { ok: false, elapsedMs: Date.now() - started, message };
    } finally {
      transporter.close();
    }
  }

  // ---------- 内部方法 ----------

  private async getOrThrow(id: number): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('通道不存在');
    return channel;
  }

  /** 找出同一 SMTP 账号下的所有通道。通道数量很少，直接内存过滤，避免大小写/空格差异漏匹配。 */
  /** 跨天时把计数清零，避免昨天用掉的额度压住今天的发送 */
  private async resetQuotas(day: string) {
    const today = dayToDbDate(day);
    await this.prisma.channel.updateMany({
      where: { OR: [{ quotaDate: null }, { quotaDate: { not: today } }] },
      data: { sentToday: 0, quotaDate: today },
    });
  }

  /** 发一封就记一封，测试发送同样消耗服务商的真实额度 */
  private async consumeQuota(id: number) {
    const day = calendarDay();
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.channel.findUnique({ where: { id } });
      if (!c) return;
      if (!isSameCalendarDay(c.quotaDate, day)) {
        await tx.channel.update({ where: { id }, data: { sentToday: 1, quotaDate: dayToDbDate(day) } });
      } else {
        await tx.channel.update({ where: { id }, data: { sentToday: { increment: 1 } } });
      }
    });
  }

  // ---------- 发件分组 ----------

  async listGroups() {
    const rows = await this.prisma.channelGroup.findMany({ orderBy: { id: 'asc' } });
    // 一条通道可以属于多个分组，所以计数按数组包含关系查，而不是外键
    const counts = await Promise.all(
      rows.map((g) => this.prisma.channel.count({ where: { groupIds: { has: g.id } } })),
    );
    return rows.map((g, i) => ({
      id: g.id,
      name: g.name,
      note: g.note,
      channelCount: counts[i],
    }));
  }

  async createGroup(name: string, note?: string) {
    const clean = name.trim();
    if (!clean) throw new BadRequestException('请填写分组名称');
    const exists = await this.prisma.channelGroup.findUnique({ where: { name: clean } });
    if (exists) throw new BadRequestException('同名分组已存在');
    const row = await this.prisma.channelGroup.create({
      data: { name: clean, note: note?.trim() || null },
    });
    return { id: row.id, name: row.name };
  }

  async updateGroup(id: number, patch: { name?: string; note?: string }) {
    const row = await this.prisma.channelGroup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('分组不存在');
    const name = patch.name?.trim();
    if (name && name !== row.name) {
      const dup = await this.prisma.channelGroup.findUnique({ where: { name } });
      if (dup) throw new BadRequestException('同名分组已存在');
    }
    await this.prisma.channelGroup.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(patch.note !== undefined ? { note: patch.note.trim() || null } : {}),
      },
    });
    return { ok: true };
  }

  /**
   * 删除分组只是解除归属，不删账号。
   * 直接删会把通道变成"未分组"，任务里按分组选号就选不到它们了，
   * 所以前端必须提示"这些账号会变成未分组"。
   */
  async removeGroup(id: number) {
    const row = await this.prisma.channelGroup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('分组不存在');
    const affected = await this.prisma.channel.count({ where: { groupIds: { has: id } } });
    // 先把这个 id 从每条通道的分组数组里摘掉，再删分组
    await this.prisma.$executeRaw`UPDATE "channels" SET "group_ids" = array_remove("group_ids", ${id})`;
    await this.prisma.channelGroup.delete({ where: { id } });
    return { ok: true, affected };
  }

  private credentialFromChannel(c: Channel): SmtpCredential {
    try {
      return credentialFromChannelUtil(c, this.cfg.credKey);
    } catch {
      throw new BadRequestException('无法解密该发件邮箱的密码，可能是 CRED_KEY 被更换过，请重新录入密码');
    }
  }

  private async resolveCredential(dto: TestConnectionDto): Promise<SmtpCredential> {
    if (dto.id) {
      const channel = await this.getOrThrow(dto.id);
      const stored = this.credentialFromChannel(channel);
      return {
        host: dto.host?.trim() || stored.host,
        port: dto.port ?? stored.port,
        secure: dto.secure ?? stored.secure,
        username: dto.username?.trim() || stored.username,
        password: dto.password || stored.password,
      };
    }

    if (!dto.host || !dto.port || !dto.username || !dto.password) {
      throw new BadRequestException('测试未保存的配置时，必须提供 host / port / username / password');
    }
    return {
      host: dto.host.trim(),
      port: dto.port,
      secure: dto.secure ?? true,
      username: dto.username.trim(),
      password: dto.password,
    };
  }

  private toPublic(c: Channel, day: string): PublicChannel {
    const ownUsed = isSameCalendarDay(c.quotaDate, day) ? c.sentToday : 0;
    return {
      id: c.id,
      host: c.host,
      port: c.port,
      secure: c.secure,
      username: c.username,
      fromName: c.fromName,
      fromEmail: c.fromEmail,
      replyTo: c.replyTo,
      dailyLimit: c.dailyLimit,
      sentToday: ownUsed,
      remaining: Math.max(0, c.dailyLimit - ownUsed),
      priority: c.priority,
      status: c.status,
      consecutiveFailures: c.consecutiveFailures,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      lastOkAt: c.lastOkAt?.toISOString() ?? null,
      lastSentAt: c.lastSentAt?.toISOString() ?? null,
      groupIds: c.groupIds ?? [],
      hasPassword: Boolean(c.passwordEnc),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
