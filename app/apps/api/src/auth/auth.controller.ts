import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, AppConfig } from '../common/config';
import { SESSION_COOKIE, SESSION_TTL_MS } from './auth.constants';
import { JwtAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, email } = await this.auth.login(dto.account, dto.password, ip);
    this.setSession(res, token);

    // 与 /auth/me 保持同一形状：前端只关心账号，两处字段不该不一样
    return { email, account: email };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response) {
    // 递增会话版本：光删浏览器的 Cookie 挡不住已经泄露出去的令牌
    await this.auth.logout().catch(() => undefined);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  /** 当前登录者：邮箱取库里的最新值，改过账号后这里立刻跟着变 */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me() {
    const info = await this.auth.accountInfo();
    return { email: info.account, account: info.account, mustChangePassword: info.mustChangePassword };
  }

  @UseGuards(JwtAuthGuard)
  @Get('account')
  account() {
    return this.auth.accountInfo();
  }

  /** 改账号或密码：必须带当前密码，光有会话 Cookie 不够 */
  @UseGuards(JwtAuthGuard)
  @Patch('account')
  async updateAccount(
    @Body() dto: UpdateAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.updateAccount({
      account: dto.account,
      newPassword: dto.newPassword,
      currentPassword: dto.currentPassword,
    });
    // 改密码后旧令牌全部失效，顺手把当前这把换成新签发的，用户不用重新登录
    if ('token' in result && result.token) this.setSession(res, result.token);
    const { token: _drop, ...info } = result;
    return info;
  }

  private setSession(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // 走纯 IP + HTTP 访问时必须是 false，否则浏览器不会保存 Cookie
      secure: this.cfg.appUrl.startsWith('https://'),
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }
}
