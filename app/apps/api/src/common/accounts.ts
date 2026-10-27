import { isSameCalendarDay } from './quota';

/**
 * 配额与发送间隔的归属是「真实邮箱账号」，不是通道记录。
 *
 * 同一个 SMTP 账号（host + username）可以建多条通道，用来区分不同的发信身份
 * （fromName / fromEmail / 任务用途），但服务商只认一个账号、一本额度。
 * 如果按通道各自计数，3 条同账号通道会显示成 150 封/天，实际只能发 50 封，
 * 最后表现为上游限流、连续失败甚至账号被风控。
 *
 * 这里把所有配额/间隔判断统一收敛到账号池，通道只保留自己的发送计数。
 */

export interface AccountChannel {
  id: number;
  name: string;
  host: string;
  username: string;
  dailyLimit: number;
  minIntervalSec: number;
  sentToday: number;
  quotaDate: Date | null;
  lastSentAt: Date | null;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastOkAt: Date | null;
}

export interface AccountPool<T extends AccountChannel = AccountChannel> {
  key: string;
  host: string;
  username: string;
  channels: T[];
  activeChannels: T[];
  /** 账号每日上限。同账号多条通道配置不一致时取最保守（最小）值。 */
  limit: number;
  /** 账号今日已发，等于该账号下所有通道 sent_today 之和。 */
  used: number;
  remaining: number;
  /** 账号级最小发送间隔。同账号多条通道配置不一致时取最严格（最大）值。 */
  minIntervalSec: number;
  /** 账号最近一次成功发送时间，取所有通道的最大值。 */
  lastSentAt: Date | null;
  /** active=至少一条通道可用；error=全部异常；paused=全部被手工停用 */
  status: 'active' | 'paused' | 'error';
  label: string;
  channelCount: number;
  errorChannels: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastOkAt: Date | null;
}

/** 账号身份：SMTP 服务器 + 用户名。大小写和首尾空格不敏感。 */
export function accountKey(host: string, username: string): string {
  return `${String(host ?? '').trim().toLowerCase()}\u0000${String(username ?? '').trim().toLowerCase()}`;
}

function latestDate(dates: (Date | null | undefined)[]): Date | null {
  let latest: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

/**
 * 把通道列表聚合成账号池。
 *
 * - used 统计所有通道（包括暂停/异常的），因为已经发出去的额度不会因为停用而退回。
 * - limit / interval 只取可用通道的配置；全部不可用时退回全部通道，便于页面展示。
 * - 同账号多条通道配置不一致时，limit 取最小、interval 取最大，先保证不超发。
 */
export function groupAccounts<T extends AccountChannel>(
  channels: T[],
  day: string,
): Map<string, AccountPool<T>> {
  const groups = new Map<string, T[]>();
  for (const c of channels) {
    const key = accountKey(c.host, c.username);
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  const pools = new Map<string, AccountPool<T>>();
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    const primary = sorted[0];
    const active = sorted.filter((c) => c.status === 'active');
    const settingsSource = active.length > 0 ? active : sorted;

    const limits = settingsSource
      .map((c) => c.dailyLimit)
      .filter((n) => Number.isFinite(n) && n > 0);
    const limit = limits.length > 0 ? Math.min(...limits) : 0;

    const intervals = settingsSource
      .map((c) => c.minIntervalSec)
      .filter((n) => Number.isFinite(n) && n > 0);
    const minIntervalSec = intervals.length > 0 ? Math.max(...intervals) : 1;

    const used = sorted.reduce(
      (sum, c) => sum + (isSameCalendarDay(c.quotaDate, day) ? Math.max(0, c.sentToday) : 0),
      0,
    );

    const status: AccountPool<T>['status'] =
      active.length > 0 ? 'active' : sorted.some((c) => c.status === 'error') ? 'error' : 'paused';

    const lastErrorChannel = [...sorted]
      .filter((c) => c.lastError)
      .sort((a, b) => (b.lastErrorAt?.getTime() ?? 0) - (a.lastErrorAt?.getTime() ?? 0))[0];

    pools.set(key, {
      key,
      host: primary.host,
      username: primary.username,
      channels: sorted,
      activeChannels: active,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      minIntervalSec,
      lastSentAt: latestDate(sorted.map((c) => c.lastSentAt)),
      status,
      label: sorted.length > 1 ? `${primary.name} 等 ${sorted.length} 条` : primary.name,
      channelCount: sorted.length,
      errorChannels: sorted.filter((c) => c.status === 'error').length,
      consecutiveFailures: Math.max(0, ...sorted.map((c) => c.consecutiveFailures ?? 0)),
      lastError: lastErrorChannel?.lastError ?? null,
      lastErrorAt: latestDate(sorted.map((c) => c.lastErrorAt)),
      lastOkAt: latestDate(sorted.map((c) => c.lastOkAt)),
    });
  }

  return pools;
}
