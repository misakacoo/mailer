import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SESSION_COOKIE } from './auth.constants';

/**
 * 面板会话鉴权。
 *
 * 只认 JWT 会话 Cookie——开放 API 已按业务要求下线，
 * 所有写操作都必须有人登录面板来做，审计日志里也能落到具体的人。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token: string | undefined = req?.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('未登录');

    try {
      req.user = { ...(await this.jwt.verifyAsync(token)), via: 'session' };
      return true;
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
  }
}
