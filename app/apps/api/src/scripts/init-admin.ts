/**
 * 首次初始化管理员账号。
 *
 * 为什么单独一个脚本而不是塞进 API 启动流程：
 * 容器和裸机都需要"只在第一次写库"，而 API 会起多个实例（api + worker），
 * 放在启动流程里迟早会撞上并发。这里用"存在即跳过"保证幂等。
 *
 * 最重要的一条：**已存在就什么都不做**。
 * 否则每次重启都会把用户自己改过的密码覆盖回初始值。
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

async function main() {
  const account = (process.env.ADMIN_EMAIL || 'admin').trim();
  const hashFromEnv = process.env.ADMIN_PASSWORD_HASH?.trim();
  const plain = process.env.ADMIN_PASSWORD?.trim();
  const forceChange = process.env.ADMIN_FORCE_PASSWORD_CHANGE === '1';

  const prisma = new PrismaClient();
  try {
    const exists = await prisma.adminAccount.findUnique({ where: { id: 1 } });
    if (exists) {
      console.log('[init-admin] 管理员账号已存在，跳过（不会覆盖已修改的账号密码）');
      return;
    }

    const passwordHash = hashFromEnv || (plain ? await bcrypt.hash(plain, BCRYPT_ROUNDS) : null);
    if (!passwordHash) {
      console.error('[init-admin] 缺少 ADMIN_PASSWORD_HASH 或 ADMIN_PASSWORD，无法初始化');
      process.exitCode = 1;
      return;
    }

    await prisma.adminAccount.create({
      data: { id: 1, email: account, passwordHash, mustChangePassword: forceChange },
    });
    console.log(
      `[init-admin] 已创建管理员账号：${account}${forceChange ? '（初始密码，登录后请在系统运维页修改）' : ''}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[init-admin] 执行失败：', e);
  process.exit(1);
});
