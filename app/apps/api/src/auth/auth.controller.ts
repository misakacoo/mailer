import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, email } = await this.auth.login(dto.account, dto.password);

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // 走纯 IP + HTTP 访问时必须是 false，否则浏览器不会保存 Cookie
      secure: this.cfg.appUrl.startsWith('https://'),
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    // 与 /auth/me 保持同一形状：前端只关心账号，两处字段不该不一样
    return { email, account: email };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
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
  updateAccount(@Body() dto: UpdateAccountDto) {
    return this.auth.updateAccount({
      account: dto.account,
      newPassword: dto.newPassword,
      currentPassword: dto.currentPassword,
    });
  }
}
