import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { log } from '../common/logger';

const CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
    });
    if (!campaign) throw new NotFoundException('任务不存在');

    // 一条 SQL 取出"分组内 + 不在抑制名单"的人。
    // 以前是先查全部联系人、再按 500 一批去查抑制名单，5 万人就是 100 次往返。
    const targets = await this.prisma.$queryRaw<{ id: number; email: string }[]>`
      SELECT c.id, c.email
      FROM contacts c
      WHERE EXISTS (
        SELECT 1 FROM list_members lm
        WHERE lm.contact_id = c.id AND lm.list_id = ANY(${campaign.listIds}::int[])
      )
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
      ORDER BY c.id
    `;

    // 分批写入：几万行拼成一条 INSERT 会超出 PostgreSQL 的绑定参数上限
    let inserted = 0;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const part = targets.slice(i, i + CHUNK);
      const r = await this.prisma.recipient.createMany({
        data: part.map((t) => ({
          campaignId,
          contactId: t.id,
          email: t.email,
          status: 'queued',
          nextAttemptAt: new Date(),
        })),
        skipDuplicates: true,
      });
      inserted += r.count;
    }
    const created = { count: inserted };

    const total = await this.prisma.recipient.count({ where: { campaignId } });
    await this.prisma.campaign.update({ where: { id: campaignId }, data: { totalCount: total } });

    log.info(
      { campaignId, total, newlyQueued: created.count },
      '任务已展开为投递明细',
    );
    // 分组内总人数（按人算，一个人属于多个分组只算一次）减实际入队数，就是被抑制名单拦下的
    const groupRows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT contact_id)::int AS count
      FROM list_members WHERE list_id = ANY(${campaign.listIds}::int[])
    `;
    const groupTotal = groupRows[0]?.count ?? targets.length;

    return {
      total,
      newlyQueued: created.count,
      skippedSuppressed: Math.max(0, groupTotal - targets.length),
    };
  }
}
