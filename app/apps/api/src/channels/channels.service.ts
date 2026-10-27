import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Channel, Prisma } from '@prisma/client';
import { AccountPool, accountKey, groupAccounts } from '../common/accounts';
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
  name: string;
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
  minIntervalSec: number;
  priority: number;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
  lastSentAt: string | null;
  hasPassword: boolean;
  /** 账号身份（host + username），同一账号下的通道共享配额与发送间隔 */
  accountKey: string;
  accountChannelCount: number;
  sharedQuota: boolean;
  accountLimit: number;
  accountUsed: number;
  accountRemaining: number;
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
    const pools = groupAccounts(rows, day);
    return rows.map((c) => this.toPublic(c, day, pools.get(accountKey(c.host, c.username))));
  }

  async create(dto: CreateChannelDto): Promise<PublicChannel> {
    const day = calendarDay();
    const host = dto.host.trim();
    const username = dto.username.trim();
    const siblings = await this.findAccountChannels(host, username);

    // 同一个 SMTP 账号只认一本账：新增发信身份时沿用账号已有上限与间隔，
    // 避免用「新增一条通道」把账号额度悄悄放大。
    const accountLimit = siblings.length
      ? Math.min(...siblings.map((c) => c.dailyLimit))
      : dto.dailyLimit ?? this.cfg.defaultDailyLimit;
    const accountInterval = siblings.length
      ? Math.max(...siblings.map((c) => c.minIntervalSec))
      : dto.minIntervalSec ?? this.cfg.defaultMinIntervalSec;

    const passwordEnc = encryptSecret(dto.password, this.cfg.credKey);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.channel.create({
        data: {
          name: dto.name.trim(),
          host,
          port: dto.port,
          secure: dto.secure,
          username,
          passwordEnc,
          fromName: dto.fromName?.trim() || null,
          fromEmail: dto.fromEmail.trim().toLowerCase(),
          replyTo: dto.replyTo?.trim().toLowerCase() || null,
          dailyLimit: accountLimit,
          minIntervalSec: accountInterval,
          priority: dto.priority ?? 0,
          groupIds: dto.groupIds ?? [],
          quotaDate: dayToDbDate(day),
        },
      });

      // 同一账号只保留一套 SMTP 连接配置：新增发信身份时把服务器/端口/密码
      // 同步给已有通道，避免同账号下出现新旧两套凭据。
      // 每条通道单独加密（各自新 IV），不要复用同一段密文。
      for (const sibling of siblings) {
        await tx.channel.update({
          where: { id: sibling.id },
          data: {
            host,
            port: dto.port,
            secure: dto.secure,
            username,
            passwordEnc: encryptSecret(dto.password, this.cfg.credKey),
            dailyLimit: accountLimit,
            minIntervalSec: accountInterval,
          },
        });
      }

      return row;
    });

    return this.toPublic(created, day, await this.poolFor(created, day));
  }

  async update(id: number, dto: UpdateChannelDto): Promise<PublicChannel> {
    const day = calendarDay();
    const existing = await this.getOrThrow(id);
    const siblings = await this.findAccountChannels(existing.host, existing.username);
    const siblingIds = siblings.map((c) => c.id);

    // SMTP 连接信息与配额设置属于账号，不属于单条通道：
    // 改一处就同步到同账号下所有通道，否则会出现"这条能发、那条密码是旧的"。
    const accountData: Prisma.ChannelUpdateManyMutationInput = {};
    if (dto.host !== undefined) accountData.host = dto.host.trim();
    if (dto.port !== undefined) accountData.port = dto.port;
    if (dto.secure !== undefined) accountData.secure = dto.secure;
    if (dto.username !== undefined) accountData.username = dto.username.trim();
    if (dto.dailyLimit !== undefined) accountData.dailyLimit = dto.dailyLimit;
    if (dto.minIntervalSec !== undefined) accountData.minIntervalSec = dto.minIntervalSec;

    // 密码留空表示不修改：前端编辑时不会拿到明文，也就无法原样回传。
    // 密码本身在事务里逐条重新加密，避免同账号多条通道的密文完全相同。
    const newPassword = dto.password !== undefined && dto.password !== '' ? dto.password : null;
    if (newPassword) {
      accountData.consecutiveFailures = 0;
      accountData.lastError = null;
    }

    // 只影响当前发信身份的字段
    // 用 Unchecked 变体才能直接写 groupId 这个外键标量（带关系时 UpdateInput 会隐藏它）
    const channelData: Prisma.ChannelUncheckedUpdateInput = {};
    if (dto.name !== undefined) channelData.name = dto.name.trim();
    if (dto.fromName !== undefined) channelData.fromName = dto.fromName?.trim() || null;
    if (dto.fromEmail !== undefined) channelData.fromEmail = dto.fromEmail.trim().toLowerCase();
    if (dto.replyTo !== undefined) channelData.replyTo = dto.replyTo?.trim().toLowerCase() || null;
    if (dto.priority !== undefined) channelData.priority = dto.priority;
    // 分组只影响当前发信身份，不跟着账号走
    if (dto.groupIds !== undefined) channelData.groupIds = dto.groupIds;
    if (dto.status !== undefined && ['active', 'paused', 'error'].includes(dto.status)) {
      channelData.status = dto.status;
    }
    // 改密码后默认把当前通道恢复为可用；不顺手启用同账号下被手工停用的其他通道
    if (dto.password !== undefined && dto.password !== '' && dto.status === undefined) {
      channelData.status = 'active';
    }

    if (Object.keys(accountData).length > 0 || Object.keys(channelData).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        if (Object.keys(accountData).length > 0) {
          await tx.channel.updateMany({ where: { id: { in: siblingIds } }, data: accountData });
        }
        if (newPassword) {
          for (const siblingId of siblingIds) {
            await tx.channel.update({
              where: { id: siblingId },
              data: { passwordEnc: encryptSecret(newPassword, this.cfg.credKey) },
            });
          }
        }
        if (Object.keys(channelData).length > 0) {
          await tx.channel.update({ where: { id }, data: channelData });
        }
      });
    }

    const updated = await this.getOrThrow(id);
    return this.toPublic(updated, day, await this.poolFor(updated, day));
  }

  async remove(id: number): Promise<{ ok: true }> {
    const channel = await this.getOrThrow(id);
    const day = calendarDay();
    const siblings = await this.findAccountChannels(channel.host, channel.username);
    const other = siblings.filter((c) => c.id !== id).sort((a, b) => a.id - b.id)[0];

    try {
      await this.prisma.$transaction(async (tx) => {
        // 删除一条同账号通道时，把它今天已用的额度转给同账号的另一条，
        // 否则账号池的已用数会凭空减少，等于凭空多出配额。
        if (other) {
          const used = isSameCalendarDay(channel.quotaDate, day) ? Math.max(0, channel.sentToday) : 0;
          const otherUsed = isSameCalendarDay(other.quotaDate, day) ? Math.max(0, other.sentToday) : 0;
          const lastSentAt =
            channel.lastSentAt && (!other.lastSentAt || channel.lastSentAt > other.lastSentAt)
              ? channel.lastSentAt
              : undefined;
          if (used > 0 || lastSentAt) {
            await tx.channel.update({
              where: { id: other.id },
              data: {
                ...(used > 0 ? { sentToday: otherUsed + used, quotaDate: dayToDbDate(day) } : {}),
                ...(lastSentAt ? { lastSentAt } : {}),
              },
            });
          }
        }
        await tx.channel.delete({ where: { id } });
      });
      return { ok: true };
    } catch (e: any) {
      if (e?.code === 'P2003') {
        throw new BadRequestException('该通道已被历史发送记录引用，不能删除。可以先停用。');
      }
      if (e?.code === 'P2025') throw new NotFoundException('通道不存在');
      throw e;
    }
  }

  /**
   * 复制一条通道：同一个 SMTP 账号可以建多条记录，用于区分不同发信身份。
   * 服务商的日发限额按账号算，复制不会提升真实配额——配额与间隔由账号池共享。
   */
  async duplicate(id: number): Promise<PublicChannel> {
    const day = calendarDay();
    const src = await this.getOrThrow(id);
    const pool = await this.poolFor(src, day);
    // 不能直接复用原密文：相同明文应使用新的 IV 重新加密，
    // 否则两条记录的 password_enc 完全一致，能从密文看出它们用了同一个密码。
    const plainPassword = this.credentialFromChannel(src).password;
    const created = await this.prisma.channel.create({
      data: {
        name: `${src.name} 副本`,
        host: src.host,
        port: src.port,
        secure: src.secure,
        username: src.username,
        passwordEnc: encryptSecret(plainPassword, this.cfg.credKey),
        fromName: src.fromName,
        fromEmail: src.fromEmail,
        replyTo: src.replyTo,
        dailyLimit: pool?.limit ?? src.dailyLimit,
        minIntervalSec: pool?.minIntervalSec ?? src.minIntervalSec,
        priority: src.priority,
        status: 'active',
        // 账号已发数由所有通道汇总，新通道必须从 0 开始，否则会重复计数
        sentToday: 0,
        quotaDate: dayToDbDate(day),
      },
    });
    return this.toPublic(created, day, await this.poolFor(created, day));
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
    const pool = await this.poolFor(channel, day);
    if (pool && pool.limit > 0 && pool.remaining <= 0) {
      throw new BadRequestException(
        `该账号今日配额已用完（${pool.used}/${pool.limit}），测试信也会消耗服务商真实额度，请明天再试`,
      );
    }
    const cred = this.credentialFromChannel(channel);
    const started = Date.now();
    const transporter = buildTransporter(cred);

    const now = new Date().toLocaleString('zh-CN', { timeZone: BUSINESS_TZ });
    const subject = `[通道测试] ${channel.name} · ${now}`;
    const text = [
      '这是一封来自邮件营销系统的通道测试邮件。',
      '',
      `通道名称：${channel.name}`,
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
    <tr><td style="color:#6b7280">通道名称</td><td>${escapeHtml(channel.name)}</td></tr>
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
  private async findAccountChannels(host: string, username: string): Promise<Channel[]> {
    const key = accountKey(host, username);
    const all = await this.prisma.channel.findMany();
    return all.filter((c) => accountKey(c.host, c.username) === key);
  }

  private async poolFor(channel: Channel, day: string): Promise<AccountPool<Channel> | undefined> {
    const all = await this.prisma.channel.findMany();
    return groupAccounts(all, day).get(accountKey(channel.host, channel.username));
  }

  private credentialFromChannel(c: Channel): SmtpCredential {
    try {
      return credentialFromChannelUtil(c, this.cfg.credKey);
    } catch {
      throw new BadRequestException('无法解密该通道的密码，可能是 CRED_KEY 被更换过，请重新录入密码');
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

  private toPublic(c: Channel, day: string, pool?: AccountPool<Channel>): PublicChannel {
    const ownUsed = isSameCalendarDay(c.quotaDate, day) ? c.sentToday : 0;
    const accountLimit = pool?.limit ?? c.dailyLimit;
    const accountUsed = pool?.used ?? ownUsed;
    const accountRemaining = pool?.remaining ?? Math.max(0, accountLimit - accountUsed);
    return {
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      secure: c.secure,
      username: c.username,
      fromName: c.fromName,
      fromEmail: c.fromEmail,
      replyTo: c.replyTo,
      // 对外的 dailyLimit / sentToday / remaining 一律是账号口径，
      // 这样前端不会再把 3 条同账号通道显示成 3 倍额度。
      dailyLimit: accountLimit,
      sentToday: accountUsed,
      remaining: accountRemaining,
      minIntervalSec: pool?.minIntervalSec ?? c.minIntervalSec,
      priority: c.priority,
      status: c.status,
      consecutiveFailures: c.consecutiveFailures,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      lastOkAt: c.lastOkAt?.toISOString() ?? null,
      lastSentAt: c.lastSentAt?.toISOString() ?? null,
      groupIds: c.groupIds ?? [],
      hasPassword: Boolean(c.passwordEnc),
      accountKey: pool?.key ?? accountKey(c.host, c.username),
      accountChannelCount: pool?.channelCount ?? 1,
      sharedQuota: (pool?.channelCount ?? 1) > 1,
      accountLimit,
      accountUsed,
      accountRemaining,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
