import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';
import { log } from '../common/logger';
import { signTrackingToken, verifyTrackingToken } from './token';

/** 1×1 透明 GIF */
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** 生成点击跳转地址（把目标 URL 纳入签名，防开放重定向） */
  clickUrl(payload: { c: number; r: number; k: number }, url: string): string {
    return `${this.cfg.appUrl}/t/c/${signTrackingToken({ ...payload, u: url }, this.cfg.jwtSecret)}`;
  }

  /** 生成打开像素地址 */
  pixelUrl(payload: { c: number; r: number; k: number }): string {
    return `${this.cfg.appUrl}/t/o/${signTrackingToken(payload, this.cfg.jwtSecret)}.gif`;
  }

  /**
   * 记录打开。只记首次：一封邮件被反复打开不该在 events 表里刷上百行，
   * 统计要的是"有没有打开过"。
   */
  async recordOpen(token: string, ip: string | null, ua: string | null): Promise<void> {
    const p = verifyTrackingToken(token, this.cfg.jwtSecret);
    if (!p) return;

    const recipient = await this.prisma.recipient.findUnique({ where: { id: p.r } });
    if (!recipient || recipient.campaignId !== p.c) return;
    if (recipient.openedAt) return;

    await this.prisma.$transaction([
      this.prisma.recipient.update({ where: { id: p.r }, data: { openedAt: new Date() } }),
      this.prisma.event.create({
        data: { campaignId: p.c, recipientId: p.r, contactId: p.k, type: 'open', ip, userAgent: ua },
      }),
    ]);
  }

  /** 记录点击并返回要跳转的地址；令牌不合法返回 null */
  async recordClick(token: string, ip: string | null, ua: string | null): Promise<string | null> {
    const p = verifyTrackingToken(token, this.cfg.jwtSecret);
    if (!p || !p.u) return null;

    const recipient = await this.prisma.recipient.findUnique({ where: { id: p.r } });
    if (!recipient || recipient.campaignId !== p.c) return null;

    const now = new Date();
    // 只在首次点击时落事件：公开端点没有限流，每点一次写一行会被刷爆表，
    // 统计要的也只是"有没有点过"
    if (!recipient.clickedAt) {
      await this.prisma.$transaction([
        this.prisma.recipient.update({
          where: { id: p.r },
          data: { clickedAt: now, openedAt: recipient.openedAt ?? now },
        }),
        this.prisma.event.create({
          data: {
            campaignId: p.c,
            recipientId: p.r,
            contactId: p.k,
            type: 'click',
            url: p.u.slice(0, 2000),
            ip,
            userAgent: ua,
          },
        }),
      ]);
    }

    return p.u;
  }

}
