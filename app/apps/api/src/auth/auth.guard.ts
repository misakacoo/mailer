import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../common/prisma.service';
import { SESSION_COOKIE } from './auth.constants';

/** 仍在用初始密码时，只放行这几条，其余一律 403 */
const MUST_CHANGE_ALLOWED = ['/auth/me', '/auth/account', '/auth/logout'];

/**
 * 面板会话鉴权。
 *
 * 只认 JWT 会话 Cookie——开放 API 已按业务要求下线，
 * 所有写操作都必须有人登录面板来做，审计日志里也能落到具体的人。
 *
 * 除了签名与过期，这里还做两件事：
 * 1. 比对 tokenVersion：登出/改密后旧令牌立刻失效，不用等 7 天自然过期；
 * 2. 检查 mustChangePassword：还在用初始密码的账号只能去改密码。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token: string | undefined = req?.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('未登录');

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    const account = await this.prisma.adminAccount.findUnique({ where: { id: 1 } });
    if (account) {
      const tv = typeof payload.tv === 'number' ? payload.tv : 0;
      if (tv !== account.tokenVersion) {
        throw new UnauthorizedException('登录已失效，请重新登录');
      }
      if (account.mustChangePassword) {
        const path = String(req.path ?? '').replace(/^\/api/, '');
        if (!MUST_CHANGE_ALLOWED.some((p) => path === p)) {
          throw new ForbiddenException('请先修改初始密码');
        }
      }
    }

    req.user = { ...payload, via: 'session' };
    return true;
  }
}
