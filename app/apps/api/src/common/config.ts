import * as fs from 'node:fs';

export const APP_CONFIG = 'APP_CONFIG';

export interface AppConfig {
  isProd: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  appUrl: string;
  adminEmail: string;
  adminPasswordHash: string;
  jwtSecret: string;
  credKey: string;
  uploadDir: string;
  tmpDir: string;
  logLevel: string;
  defaultDailyLimit: number;
  /** 备份目录，用于运维自检里判断"上次备份是什么时候"。未配置则跳过该检查。 */
  backupDir: string | null;
  /** 站点证书路径，用于到期提醒。未配置则跳过该检查。 */
  tlsCertPath: string | null;
  /** 允许 SMTP/IMAP 指向内网地址（只给本地调试用，生产保持 false） */
  allowPrivateSmtp: boolean;
}

const REQUIRED = [
  'DATABASE_URL',
  'APP_URL',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD_HASH',
  'JWT_SECRET',
  'CRED_KEY',
  'UPLOAD_DIR',
];

function fail(lines: string[]): never {
  // 启动即失败，绝不带着错误配置跑起来（错配的凭据比崩溃更难查）
  console.error('\n[config] 配置校验未通过，服务拒绝启动：');
  for (const l of lines) console.error('  - ' + l);
  console.error('\n配置文件：环境变量或 .env 文件\n');
  process.exit(1);
}

function int(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

export function loadConfig(): AppConfig {
  const problems: string[] = [];

  const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length) {
    return fail(missing.map((k) => `缺少环境变量 ${k}`));
  }

  const databaseUrl = process.env.DATABASE_URL!.trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL 必须是以 postgresql:// 开头的连接串');
  }

  const appUrl = process.env.APP_URL!.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(appUrl)) {
    problems.push('APP_URL 必须以 http:// 或 https:// 开头');
  }

  // 这里是「登录账号」，不是收发件邮箱：默认值是 admin 这种短名。
  // 只要求非空、长度合理、无空白，不能按邮箱格式校验，否则默认配置直接起不来。
  const adminEmail = process.env.ADMIN_EMAIL!.trim().toLowerCase();
  if (!/^[A-Za-z0-9._@+-]{3,120}$/.test(adminEmail)) {
    problems.push('ADMIN_EMAIL 需为 3–120 位，只允许字母、数字与 . _ @ + -（默认 admin）');
  }

  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH!.trim();
  if (!/^\$2[aby]\$/.test(adminPasswordHash)) {
    problems.push('ADMIN_PASSWORD_HASH 不是 bcrypt 哈希（应以 $2a$/$2b$/$2y$ 开头）');
  }

  const jwtSecret = process.env.JWT_SECRET!.trim();
  if (jwtSecret.length < 32) {
    problems.push('JWT_SECRET 长度不足 32 字符');
  }

  const credKey = process.env.CRED_KEY!.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(credKey)) {
    problems.push('CRED_KEY 必须是 64 位十六进制（32 字节，用于 AES-256-GCM）');
  }

  const uploadDir = process.env.UPLOAD_DIR!.trim();
  if (!uploadDir.startsWith('/')) {
    problems.push('UPLOAD_DIR 必须是绝对路径');
  } else {
    try {
      fs.accessSync(uploadDir, fs.constants.W_OK);
    } catch {
      problems.push(`UPLOAD_DIR 不存在或不可写：${uploadDir}`);
    }
  }

  if (problems.length) return fail(problems);

  return {
    isProd: process.env.NODE_ENV === 'production',
    port: int(process.env.PORT, 3000),
    host: process.env.HOST?.trim() || '127.0.0.1',
    databaseUrl,
    appUrl,
    adminEmail,
    adminPasswordHash,
    jwtSecret,
    credKey,
    uploadDir,
    tmpDir: process.env.TMP_DIR?.trim() || uploadDir,
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    defaultDailyLimit: int(process.env.DEFAULT_DAILY_LIMIT, 50),
    backupDir: process.env.BACKUP_DIR?.trim() || null,
    tlsCertPath: process.env.TLS_CERT_PATH?.trim() || null,
    allowPrivateSmtp: process.env.ALLOW_PRIVATE_SMTP === '1',
  };
}
