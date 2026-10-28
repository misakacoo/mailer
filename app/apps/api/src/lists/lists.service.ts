import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateListDto, UpdateListDto } from './dto/list.dto';

/** 系统内置分组：硬退信的地址自动归到这里，用户不能删除 */
export const UNDELIVERABLE_KEY = 'undeliverable';
export const UNDELIVERABLE_NAME = '地址不存在';

@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const lists = await this.prisma.list.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      systemKey: l.systemKey,
      contactCount: l._count.members,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  async create(dto: CreateListDto) {
    const created = await this.prisma.list.create({
      data: { name: dto.name.trim(), description: dto.description?.trim() || null },
    });
    return {
      id: created.id,
      name: created.name,
      description: created.description,
      systemKey: created.systemKey,
      contactCount: 0,
    };
  }

  async update(id: number, dto: UpdateListDto) {
    await this.getOrThrow(id);
    const updated = await this.prisma.list.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      },
      include: { _count: { select: { members: true } } },
    });
    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      systemKey: updated.systemKey,
      contactCount: updated._count.members,
    };
  }

  /**
   * 删除分组 = 连同组内联系人一起删除（用户明确要求的语义）。
   *
   * 但抑制名单**不删**：那是"这个地址不存在"的事实记录，跟着删等于把黑名单撤销，
   * 同一份名单再导进来就会继续撞死地址。
   * 投递明细靠 recipients.contactId 的 SetNull 保留，历史报表不受影响。
   * 系统分组（地址不存在）不允许删除。
   */
  async remove(id: number) {
    const list = await this.getOrThrow(id);
    if (list.systemKey) throw new BadRequestException(`「${list.name}」是系统分组，不能删除`);

    // 任务里的 listIds 是数组，没有外键兜底；删掉被引用的分组会让那个任务
    // 之后连改名字都保存不了（assertRefs 一直报"分组不存在"）
    const used = await this.prisma.campaign.count({
      where: { listIds: { has: id }, deletedAt: null },
    });
    if (used > 0) {
      throw new BadRequestException(`还有 ${used} 个任务在使用这个分组，请先调整任务的分组`);
    }

    const removed = await this.prisma.$transaction(async (tx) => {
      const n = await this.deleteMembers(tx, id);
      await tx.list.delete({ where: { id } });
      return n;
    });
    return { ok: true, deletedContacts: removed };
  }

  /** 清空分组：删掉组内联系人，分组本身保留。系统分组也允许清空（就是清掉死地址） */
  async clear(id: number) {
    await this.getOrThrow(id);
    const removed = await this.prisma.$transaction((tx) => this.deleteMembers(tx, id));
    return { ok: true, deletedContacts: removed };
  }

  /**
   * 删掉某个分组的全部成员（连同联系人本身），返回删除人数。
   * 分批执行：几万人的分组拼成一条 DELETE 会超过 SQL 参数上限，
   * 而"清空分组"本应是最稳的运维动作。
   */
  private async deleteMembers(
    tx: Prisma.TransactionClient,
    listId: number,
  ): Promise<number> {
    const members = await tx.listMember.findMany({
      where: { listId },
      select: { contactId: true },
    });
    if (members.length === 0) return 0;

    const ids = members.map((m) => m.contactId);
    for (let i = 0; i < ids.length; i += 500) {
      await tx.contact.deleteMany({ where: { id: { in: ids.slice(i, i + 500) } } });
    }
    return ids.length;
  }

  /** 取「地址不存在」分组；迁移已建好，这里兜底防止被历史数据漏掉 */
  async ensureUndeliverableList(): Promise<number> {
    const list = await this.prisma.list.upsert({
      where: { systemKey: UNDELIVERABLE_KEY },
      update: {},
      create: {
        name: UNDELIVERABLE_NAME,
        description: '硬退信的地址会自动移到这里',
        systemKey: UNDELIVERABLE_KEY,
      },
      select: { id: true },
    });
    return list.id;
  }

  /**
   * 把地址移进「地址不存在」分组。
   *
   * 从其他分组里移出而不是只加入：死地址留在原分组，圈选受众时人数会虚高
   * （显示 2 人实际只能发 1 封），用户还得自己排查。移出去后其他分组的人数
   * 就是真实可发数量。拦截本身仍由抑制名单负责，不依赖分组。
   */
  async moveToUndeliverable(email: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!contact) return;

    const listId = await this.ensureUndeliverableList();
    await this.prisma.$transaction([
      this.prisma.listMember.deleteMany({
        where: { contactId: contact.id, listId: { not: listId } },
      }),
      this.prisma.listMember.createMany({
        data: [{ listId, contactId: contact.id }],
        skipDuplicates: true,
      }),
    ]);
  }

  private async getOrThrow(id: number) {
    const list = await this.prisma.list.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('分组不存在');
    return list;
  }
}
