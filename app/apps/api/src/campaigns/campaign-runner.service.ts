import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { log } from '../common/logger';

const CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 按权重排出分流顺序。
 *
 * 两个细节都不能省：
 *
 * 1. 先按最大公约数约简，避免 50/50 排出 100 项、100/100 排出 200 项这种无意义长度。
 * 2. 必须是交织（A B A A B A…）而不是分块（A A A A A B B B）。
 *    分块看似比例正确，实际是把 A 组全排在前半天——发信按 30 秒一封串行推进，
 *    前 7 封全是 A、后 3 封才是 B，两组的发出时段完全不同。
 *    早上发和晚上发的打开率本来就有差异，最后得出的"A 比 B 好"可能只是时段效应。
 *
 * 用平滑加权轮询（smooth weighted round-robin）生成序列：
 * 每轮给每个变体加上自己的权重，取当前值最大的那个，再把它的值减去总权重。
 * 这样 70/30 得到 A B A A A B A A B A，任何前缀里的比例都贴近 7:3。
 */
export function buildVariantPattern(variants: { label: string; weight: number }[]): string[] {
  const weights = variants.map((v) => Math.max(1, Math.round(v.weight)));
  const base = weights.reduce((a, b) => gcd(a, b), weights[0] ?? 1) || 1;
  const normalized = weights.map((w) => Math.max(1, Math.round(w / base)));
  const total = normalized.reduce((a, b) => a + b, 0);

  const current = normalized.map(() => 0);
  const pattern: string[] = [];
  for (let i = 0; i < total; i++) {
    for (let k = 0; k < normalized.length; k++) current[k] += normalized[k];
    let best = 0;
    for (let k = 1; k < normalized.length; k++) if (current[k] > current[best]) best = k;
    current[best] -= total;
    pattern.push(variants[best].label);
  }
  return pattern;
}

/**
 * 把任务展开成投递明细。
 *
 * 单拎出来是因为有两个调用方：面板上的「开始发送」，和 worker 里的定时调度器。
 * 这段逻辑一旦分叉成两份，早晚会出现「手动开始会跳过抑制名单、定时不会」这类事故。
 *
 * 只负责把队列铺开并把 total_count 对齐，不负责改任务状态——状态由调用方先领取，
 * 这样两个入口都能用条件更新做幂等（重复触发不会重复排队）。
 */
@Injectable()
export class CampaignRunnerService {
  constructor(private readonly prisma: PrismaService) {}

  async materialize(
    campaignId: number,
  ): Promise<{ total: number; newlyQueued: number; skippedSuppressed: number }> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { variants: { orderBy: { label: 'asc' } } },
    });
    if (!campaign) throw new NotFoundException('任务不存在');

    const contacts = await this.prisma.contact.findMany({
      where: {
        // 是否可发只由抑制名单决定（退信/投诉/手工拉黑），联系人本身没有"订阅状态"
        listMembers: { some: { listId: { in: campaign.listIds } } },
      },
      select: { id: true, email: true },
      orderBy: { id: 'asc' },
    });

    // 抑制名单单独查：退信过的地址即使还在分组里也必须排除
    const suppressed = new Set<string>();
    for (const batch of chunk(
      contacts.map((x) => x.email),
      CHUNK,
    )) {
      const rows = await this.prisma.suppression.findMany({
        where: { email: { in: batch } },
        select: { email: true },
      });
      rows.forEach((r) => suppressed.add(r.email));
    }

    const targets = contacts.filter((x) => !suppressed.has(x.email));
    const pattern =
      campaign.variants.length >= 2
        ? buildVariantPattern(campaign.variants.map((v) => ({ label: v.label, weight: v.weight })))
        : [];

    const created = await this.prisma.recipient.createMany({
      data: targets.map((t, i) => ({
        campaignId,
        contactId: t.id,
        email: t.email,
        status: 'queued',
        nextAttemptAt: new Date(),
        variant: pattern.length > 0 ? pattern[i % pattern.length] : null,
      })),
      skipDuplicates: true,
    });

    const total = await this.prisma.recipient.count({ where: { campaignId } });
    await this.prisma.campaign.update({ where: { id: campaignId }, data: { totalCount: total } });

    log.info(
      { campaignId, total, newlyQueued: created.count, variants: campaign.variants.length },
      '任务已展开为投递明细',
    );
    return {
      total,
      newlyQueued: created.count,
      skippedSuppressed: contacts.length - targets.length,
    };
  }
}
