/**
 * 配额相关的"日"必须按业务时区算，不能直接用服务器本地时间。
 * 服务器时区是 UTC，若直接取 new Date() 的日期，配额会在北京时间早上 8 点重置。
 * 这里统一按 Asia/Shanghai 判定"今天"，再用 UTC 零点表示这个日历日，
 * 与 Prisma @db.Date 列的存储方式对齐。
 */
export const BUSINESS_TZ = 'Asia/Shanghai';

export function calendarDay(now: Date = new Date(), tz: string = BUSINESS_TZ): string {
  // en-CA 的输出正好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 把 "YYYY-MM-DD" 转成 @db.Date 列的写入值（UTC 零点） */
export function dayToDbDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** 判断数据库里的日期列是否就是指定的那一天 */
export function isSameCalendarDay(dbDate: Date | null | undefined, day: string): boolean {
  if (!dbDate) return false;
  return dbDate.toISOString().slice(0, 10) === day;
}

/** 某个 UTC 时刻在指定时区的偏移量（毫秒）。用于把"某天的零点"换算成 UTC 时刻。 */
function tzOffsetMs(tz: string, utcDate: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcDate);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Intl 在午夜可能给出 24 时，取模归零
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - utcDate.getTime();
}

/** "YYYY-MM-DD"（业务时区的日历日）→ 该日零点对应的 UTC 时刻 */
export function dayStartUtc(day: string, tz: string = BUSINESS_TZ): Date {
  const naive = new Date(`${day}T00:00:00.000Z`);
  return new Date(naive.getTime() - tzOffsetMs(tz, naive));
}

/** 日历日加减，纯字符串算术，不受本地时区影响 */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 最近 n 天的日历日列表（含今天），从旧到新 */
export function recentDays(n: number, tz: string = BUSINESS_TZ): string[] {
  const today = calendarDay(new Date(), tz);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}
