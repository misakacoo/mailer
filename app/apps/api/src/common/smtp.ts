import { Channel } from '@prisma/client';
import nodemailer from 'nodemailer';
import { decryptSecret } from './crypto';

export interface SmtpCredential {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

/** 把 nodemailer 的底层错误翻译成能指导操作的中文 */
export function smtpErrorText(e: any): string {
  const code: string = e?.code ?? 'UNKNOWN';
  const table: Record<string, string> = {
    EAUTH: '认证失败：用户名或密码/授权码不正确',
    ETIMEDOUT: '连接超时：检查服务器地址、端口与网络出站策略',
    ESOCKET: '连接中断或 TLS 握手失败：确认端口与加密方式是否匹配（465 用 SSL，587 用 STARTTLS）',
    EDNS: '域名解析失败：检查 SMTP 服务器地址是否写错',
    EENVELOPE: '发件人或收件人被服务器拒绝',
    EMESSAGE: '邮件内容被服务器拒绝',
    ECONNECTION: '无法建立连接：端口可能被封锁',
  };
  const head = table[code] ?? '发送失败';
  const detail = [
    e?.responseCode ? `响应码 ${e.responseCode}` : '',
    e?.response ? String(e.response).trim() : '',
  ]
    .filter(Boolean)
    .join('，');
  return detail ? `${head}（${code}，${detail}）` : `${head}（${code}）`;
}

export function credentialFromChannel(c: Channel, credKey: string): SmtpCredential {
  let password: string;
  try {
    password = decryptSecret(c.passwordEnc, credKey);
  } catch {
    throw new Error('无法解密该通道的密码，可能是 CRED_KEY 被更换过，请重新录入密码');
  }
  return { host: c.host, port: c.port, secure: c.secure, username: c.username, password };
}

export function buildTransporter(c: SmtpCredential) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.username, pass: c.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2' },
  });
}
