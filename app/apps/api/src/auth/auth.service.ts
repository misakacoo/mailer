import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';

export interface SessionUser {
  sub: string;
  email: string;
}

export interface AccountInfo {
  /** 登录账号：允许是邮箱，也允许 admin 这种短名 */
  account: string;
  /** 仍在使用初始默认密码 */
  mustChangePassword: boolean;
  updatedAt: string;
}

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD = 12;
const ACCOUNT_RE = /^[A-Za-z0-9._@+-]{3,120}$/;
/** bcrypt 只取前 72 字节，超长部分等于没设 */
const MAX_PASSWORD_BYTES = 72;

/** 常见弱口令：只拦最低成本的几个，不引入依赖 */
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '123456', '123456789', '12345678',
  'qwerty', 'qwerty123', 'abc123', 'admin', 'admin123', 'admin888', '111111', '000000',
]);

/**
 * 登录失败限流（进程内）。
 * 单实例部署够用；多实例时换成 Redis 或反向代理层的 limit_req。
 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const loginFails = new Map<string, { count: number; resetAt: number }>();

function throttleKey(account: string, ip: string): string {
  return `${account.trim().toLowerCase()}|${ip}`;
}

/**
 * 管理员账号。
 *
 * 历史版本把账号密码放在环境变量里（ADMIN_EMAIL / ADMIN_PASSWORD_HASH），
 * 改一次密码就要登服务器改 env 再重启，对"分发给别人自己部署"是硬伤。
 * 现在账号落在 admin_account 表：env 只用于**首次初始化**，之后一律以库为准。
 *
 * 兼容性：库里还没有记录时（老部署升级上来），第一次用到就用 env 的值补一条，
 * 所以升级不需要停机改配置，也不会把用户已经改过的密码覆盖回去。
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /** 读取账号记录；没有就用 env 初始化一条（并发下靠 upsert 兜住） */
  private async ensureAccount() {
    const existing = await this.prisma.adminAccount.findUnique({ where: { id: 1 } });
    if (existing) return existing;

    return this.prisma.adminAccount.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        email: this.cfg.adminEmail,
        passwordHash: this.cfg.adminPasswordHash,
        // 老部署从 env 迁移过来的密码是用户自己设的，不提示改
        mustChangePassword: false,
      },
    });
  }

  async login(
    account: string,
    password: string,
    ip = 'unknown',
  ): Promise<{ token: string; email: string }> {
    const key = throttleKey(account, ip);
    const now = Date.now();
    const hit = loginFails.get(key);
    if (hit && hit.resetAt > now && hit.count >= LOGIN_MAX_FAILS) {
      const waitSec = Math.ceil((hit.resetAt - now) / 1000);
      throw new UnauthorizedException(`尝试次数过多，请 ${waitSec} 秒后再试`);
    }

    const row = await this.ensureAccount();
    const accountOk = account.trim().toLowerCase() === row.email.trim().toLowerCase();

    let passOk = false;
    try {
      passOk = await bcrypt.compare(password, row.passwordHash);
    } catch {
      passOk = false;
    }

    // 账号与密码分开校验，但对外只给同一句错误，避免泄露"账号对不对"
    if (!accountOk || !passOk) {
      const prev = hit && hit.resetAt > now ? hit : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      loginFails.set(key, { count: prev.count + 1, resetAt: prev.resetAt });
      throw new UnauthorizedException('账号或密码不正确');
    }

    loginFails.delete(key);
    const token = await this.jwt.signAsync({
      sub: 'admin',
      email: row.email,
      tv: row.tokenVersion,
    });
    return { token, email: row.email };
  }

  /** 登出：把会话版本 +1，旧 Cookie 立即作废（光删 Cookie 挡不住已经泄露的令牌） */
  async logout(): Promise<void> {
    await this.ensureAccount();
    await this.prisma.adminAccount.update({
      where: { id: 1 },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  async accountInfo(): Promise<AccountInfo> {
    const row = await this.ensureAccount();
    return {
      account: row.email,
      mustChangePassword: row.mustChangePassword,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 修改账号或密码。
   * 必须验当前密码：会话 Cookie 有效期 7 天，只凭 Cookie 就能改密码的话，
   * 拿到已登录浏览器的人可以直接把管理员顶掉。
   */
  async updateAccount(input: {
    account?: string;
    newPassword?: string;
    currentPassword: string;
  }): Promise<AccountInfo & { token?: string }> {
    const row = await this.ensureAccount();

    const passOk = await bcrypt
      .compare(input.currentPassword ?? '', row.passwordHash)
      .catch(() => false);
    if (!passOk) throw new BadRequestException('当前密码不正确');

    const data: { email?: string; passwordHash?: string; mustChangePassword?: boolean } = {};

    if (input.account !== undefined) {
      const next = input.account.trim();
      if (!ACCOUNT_RE.test(next)) {
        throw new BadRequestException('账号需为 3–120 位，只允许字母、数字与 . _ @ + -');
      }
      data.email = next;
    }

    if (input.newPassword) {
      const pwd = input.newPassword;
      if (pwd.length < MIN_PASSWORD) {
        throw new BadRequestException(`新密码至少 ${MIN_PASSWORD} 位`);
      }
      if (Buffer.byteLength(pwd, 'utf8') > MAX_PASSWORD_BYTES) {
        throw new BadRequestException(`新密码不能超过 ${MAX_PASSWORD_BYTES} 字节（bcrypt 只认这么多）`);
      }
      if (WEAK_PASSWORDS.has(pwd.toLowerCase())) {
        throw new BadRequestException('这个密码太常见了，换一个');
      }
      if (pwd === input.currentPassword) {
        throw new BadRequestException('新密码不能与当前密码相同');
      }
      data.passwordHash = await bcrypt.hash(pwd, BCRYPT_ROUNDS);
      // 自己改过密码，就不再提示「仍在使用默认密码」
      data.mustChangePassword = false;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要修改的内容');
    }

    // 改密码会让所有旧会话失效（tokenVersion +1），所以要把当前这把换成新签发的
    const updated = await this.prisma.adminAccount.update({
      where: { id: 1 },
      data: data.passwordHash
        ? { ...data, tokenVersion: { increment: 1 } }
        : data,
    });
    const token = data.passwordHash
      ? await this.jwt.signAsync({ sub: 'admin', email: updated.email, tv: updated.tokenVersion })
      : undefined;
    return {
      account: updated.email,
      mustChangePassword: updated.mustChangePassword,
      updatedAt: updated.updatedAt.toISOString(),
      ...(token ? { token } : {}),
    };
  }
}
