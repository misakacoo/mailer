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

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 6;
const ACCOUNT_RE = /^[A-Za-z0-9._@+-]{3,120}$/;

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

  async login(account: string, password: string): Promise<{ token: string; email: string }> {
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
      throw new UnauthorizedException('账号或密码不正确');
    }

    const token = await this.jwt.signAsync({ sub: 'admin', email: row.email });
    return { token, email: row.email };
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
  }): Promise<AccountInfo> {
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
      if (input.newPassword.length < MIN_PASSWORD) {
        throw new BadRequestException(`新密码至少 ${MIN_PASSWORD} 位`);
      }
      if (input.newPassword === input.currentPassword) {
        throw new BadRequestException('新密码不能与当前密码相同');
      }
      data.passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
      // 自己改过密码，就不再提示「仍在使用默认密码」
      data.mustChangePassword = false;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要修改的内容');
    }

    const updated = await this.prisma.adminAccount.update({ where: { id: 1 }, data });
    return {
      account: updated.email,
      mustChangePassword: updated.mustChangePassword,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
