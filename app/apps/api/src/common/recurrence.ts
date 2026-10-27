/**
 * 周期任务的时间推进。
 *
 * 全部按 UTC 做加法：库里存的是 UTC 时刻，而 Asia/Shanghai 没有夏令时，
 * 加天数不会让"每天早上 9 点"漂成 8 点或 10 点。
 * 如果将来要支持有夏令时的时区，这里得改成按业务时区的墙钟时间推进。
 */
export const RECURRENCES = ['daily', 'weekly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
};

export function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === 'string' && (RECURRENCES as readonly string[]).includes(value);
}

/**
 * 从 from 起算下一轮。
 *
 * monthly 要做月末收敛：1 月 31 日 + 1 个月没有 2 月 31 日，
 * 直接 setUTCMonth 会溢出到 3 月 3 日，等于跳过整个二月还不报错。
 */
export function nextOccurrence(from: Date, kind: Recurrence, interval: number): Date {
  const step = Math.max(1, Math.trunc(interval) || 1);
  const next = new Date(from.getTime());

  if (kind === 'daily') {
    next.setUTCDate(next.getUTCDate() + step);
    return next;
  }
  if (kind === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7 * step);
    return next;
  }

  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + step);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/** 人话描述，用于列表与日志 */
export function describeRecurrence(kind: string, interval: number): string {
  const label = RECURRENCE_LABEL[kind as Recurrence] ?? kind;
  return interval > 1 ? `每 ${interval} ${label.slice(1)}` : label;
}
