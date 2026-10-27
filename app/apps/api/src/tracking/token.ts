import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 追踪令牌：把 campaign / recipient / contact 和目标 URL 一起签名。
 *
 * 为什么把 URL 也签进去：如果只签收件人、URL 走查询参数，
 * 任何人拿到一个合法令牌就能拼出 /t/c/<合法token>?u=https://evil.com，
 * 把我们的域名当开放重定向用。把 URL 纳入签名后，改一个字符就验不过。
 */

export interface TrackingPayload {
  /** campaign id */
  c: number;
  /** recipient id */
  r: number;
  /** contact id */
  k: number;
  /** 点击目标 URL（打开像素不需要） */
  u?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as any).toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signTrackingToken(payload: TrackingPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}

export function verifyTrackingToken(token: string, secret: string): TrackingPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(secret, body);

  // 定长比较，避免按字节时间侧信道猜签名
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      typeof parsed?.c !== 'number' ||
      typeof parsed?.r !== 'number' ||
      typeof parsed?.k !== 'number'
    ) {
      return null;
    }
    if (parsed.u !== undefined) {
      if (typeof parsed.u !== 'string') return null;
      // 只允许 http(s)，杜绝 javascript: / data: 这类协议
      if (!/^https?:\/\//i.test(parsed.u)) return null;
    }
    return parsed as TrackingPayload;
  } catch {
    return null;
  }
}
