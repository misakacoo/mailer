/**
 * 判断一条 SMTP / DSN 报错是不是「地址不存在」。
 *
 * 为什么要区分：5xx 都是永久失败，都会进抑制名单不再重试，但只有"这个人根本不存在"
 * 才应该被移进「地址不存在」分组。收件方策略拒收（如 554 rejected by policy）、
 * 邮箱已满（552）这类地址本身是有效的，归进「地址不存在」会误导。
 *
 * 关键词取自 QQ / Gmail / Outlook / 163 的实际退信文案。
 */
const ADDRESS_MISSING_PATTERNS = [
  /does not exist/i,
  /no such (?:user|mailbox|recipient)/i,
  /(?:user|mailbox|recipient) (?:is )?unknown/i,
  /unknown (?:user|recipient|address)/i,
  /mailbox (?:not found|does not exist)/i,
  /invalid (?:recipient|mailbox|address)/i,
  /(?:recipient|address) (?:not found|rejected)/i,
  /unrouteable address/i,
  /不存在/,
  /无此用户/,
  /用户不存在/,
];

export function isAddressMissing(text: string | null | undefined): boolean {
  if (!text) return false;
  return ADDRESS_MISSING_PATTERNS.some((re) => re.test(text));
}
