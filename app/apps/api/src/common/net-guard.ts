import { BadRequestException } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * 出站目标校验。
 *
 * SMTP / IMAP 主机地址完全由用户填写，如果不拦，任何拿到面板的人都能让服务器
 * 去连内网的任意 host:port——既是一个端口扫描器，也能把已保存的 SMTP 密码
 * 以 AUTH 的形式发到自己的服务器上。
 *
 * 只放行公网地址；本地调试用 ALLOW_PRIVATE_SMTP=1 显式放开。
 */

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 运营商级 NAT
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((re) => re.test(ip));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7（唯一本地）与 fe80::/10（链路本地）
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // IPv4 映射地址 ::ffff:10.0.0.1
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return false;
}

/**
 * 校验主机可安全出站：能解析、且所有解析结果都是公网地址。
 * allowPrivate 只给本地调试用。
 */
export async function assertOutboundHost(host: string, allowPrivate: boolean): Promise<void> {
  const target = host.trim().replace(/^\[|\]$/g, '');
  if (!target) throw new BadRequestException('请填写服务器地址');

  if (/^(localhost|.*\.local|.*\.internal)$/i.test(target)) {
    if (!allowPrivate) throw new BadRequestException('不允许使用本机或内网地址');
    return;
  }

  // 已经是字面量 IP 的，直接判断
  if (isIP(target)) {
    if (!allowPrivate && isPrivateAddress(target)) {
      throw new BadRequestException('不允许使用内网地址');
    }
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(target, { all: true });
  } catch {
    throw new BadRequestException('无法解析该服务器地址');
  }
  if (addrs.length === 0) throw new BadRequestException('无法解析该服务器地址');

  if (!allowPrivate) {
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        throw new BadRequestException('该域名解析到内网地址，已拒绝');
      }
    }
  }
}
