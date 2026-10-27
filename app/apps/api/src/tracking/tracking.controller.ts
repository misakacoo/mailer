import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PIXEL_GIF, TrackingService } from './tracking.service';

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim().slice(0, 64);
  return req.socket?.remoteAddress ?? null;
}

/**
 * 追踪入口。路径不带 /api 前缀（nginx 会把 /t/ 重写到 /api/t/），
 * 因为这两个地址会直接出现在邮件正文里，越短越好，也别暴露内部结构。
 */
@Controller('t')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  /** 打开像素：无论令牌是否有效都必须返回图片，否则邮件里会出现破图 */
  @Get('o/:token')
  async open(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    try {
      await this.tracking.recordOpen(
        token.replace(/\.gif$/i, ''),
        clientIp(req),
        (req.headers['user-agent'] as string) ?? null,
      );
    } catch {
      // 统计失败不能影响图片返回
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Length', String(PIXEL_GIF.length));
    res.end(PIXEL_GIF);
  }

  /** 点击跳转：令牌里带了签名过的目标地址，验不过就不跳 */
  @Get('c/:token')
  async click(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const url = await this.tracking.recordClick(
      token,
      clientIp(req),
      (req.headers['user-agent'] as string) ?? null,
    );
    if (!url) {
      res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>链接无效</title><p style="font-family:system-ui;padding:32px;color:#41413b">这个链接无效或已失效。</p>',
      );
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  }
}
