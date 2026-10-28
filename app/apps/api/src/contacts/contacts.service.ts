import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateContactDto, QueryContactsDto, UpdateContactDto } from './dto/contact.dto';

/**
 * 邮箱规范化。
 *
 * 只做 trim / 去 mailto: / 转小写这些"无损"操作。
 * 以前还会把空白引号尖括号删掉（`jo hn@x.com` → `john@x.com`），
 * 那等于把两个不同地址悄悄合并成一个，导入时更难解释。
 * 含这些字符的一律交给格式校验判非法。
 */
export function normalizeEmail(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: QueryContactsDto) {
    const page = Math.max(1, q.page || 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize || 20));

    const where: Prisma.ContactWhereInput = {};
    if (q.q?.trim()) {
      const kw = q.q.trim();
      where.OR = [
        { email: { contains: kw, mode: 'insensitive' } },
        { name: { contains: kw, mode: 'insensitive' } },
      ];
    }
    if (q.listId) where.listMembers = { some: { listId: q.listId } };

    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { listMembers: { include: { list: { select: { id: true, name: true } } } } },
      }),
      this.prisma.contact.count({ where }),
    ]);

    // 只查当前页涉及到的邮箱：以前每翻一页都把整张抑制表读进内存再比对
    const blocked = new Set(
      rows.length
        ? (
            await this.prisma.suppression.findMany({
              where: { email: { in: rows.map((r) => r.email) } },
              select: { email: true },
            })
          ).map((x) => x.email)
        : [],
    );

    return {
      items: rows.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        fields: c.fields,
        source: c.source,
        createdAt: c.createdAt.toISOString(),
        lists: c.listMembers.map((m) => m.list),
        undeliverable: blocked.has(c.email),
      })),
      total,
      page,
      pageSize,
    };
  }

  async stats() {
    const [total, blocked] = await Promise.all([
      this.prisma.contact.count(),
      // 以前把整张抑制表读出来塞进 IN：名单上万后参数直接超上限，接口 500
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM contacts c
        WHERE EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
      `,
    ]);
    return { total, undeliverable: blocked[0]?.count ?? 0 };
  }

  async create(dto: CreateContactDto) {
    const email = normalizeEmail(dto.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    if (email.length > 254) throw new BadRequestException('邮箱过长');

    const exists = await this.prisma.contact.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('该邮箱已存在');

    if (dto.listId) {
      const list = await this.prisma.list.findUnique({ where: { id: dto.listId } });
      if (!list) throw new BadRequestException('分组不存在');
    }

    const created = await this.prisma.contact
      .create({
        data: {
          email,
          name: dto.name?.trim() || null,
          fields: dto.fields ?? {},
          source: 'manual',
          ...(dto.listId ? { listMembers: { create: [{ listId: dto.listId }] } } : {}),
        },
      })
      // 并发下两个请求都通过了上面的存在性检查，唯一索引会挡住后到的那个
      .catch((e) => {
        if (e?.code === 'P2002') throw new BadRequestException('该邮箱已存在');
        if (e?.code === 'P2003') throw new BadRequestException('分组不存在');
        throw e;
      });
    return { id: created.id, email: created.email };
  }

  async update(id: number, dto: UpdateContactDto) {
    const current = await this.getOrThrow(id);

    let email: string | undefined;
    if (dto.email !== undefined) {
      email = normalizeEmail(dto.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw new BadRequestException('邮箱格式不正确');
      }
      if (email.length > 254) throw new BadRequestException('邮箱过长');

      if (email !== current.email) {
        // 改成别人的地址会把两个人的记录混在一起
        const taken = await this.prisma.contact.findUnique({ where: { email } });
        if (taken) throw new BadRequestException('该邮箱已被其他联系人使用');

        // 抑制名单里的地址是已确认发不出去的，不能通过"改邮箱"把联系人变成死地址
        const blocked = await this.prisma.suppression.findUnique({ where: { email } });
        if (blocked) throw new BadRequestException('该邮箱已被标记为地址不存在，不能使用');
      }
    }

    const updated = await this.prisma.contact
      .update({
        where: { id },
        data: {
          ...(email !== undefined ? { email } : {}),
          ...(dto.name !== undefined ? { name: dto.name?.trim() || null } : {}),
          ...(dto.fields !== undefined ? { fields: dto.fields } : {}),
        },
      })
      // 并发改名撞唯一索引时给出可读提示，而不是 500
      .catch((e) => {
        if (e?.code === 'P2002') throw new BadRequestException('该邮箱已被其他联系人使用');
        throw e;
      });

    return { id: updated.id, email: updated.email };
  }

  /**
   * 替换联系人的分组归属。
   * 之前只能在新建联系人或导入时指定分组，老联系人无法在 UI 上加入新分组。
   */
  async setLists(id: number, listIds: number[]) {
    const contact = await this.getOrThrow(id);
    const unique = [...new Set(listIds)];

    if (unique.length > 0) {
      const found = await this.prisma.list.count({ where: { id: { in: unique } } });
      if (found !== unique.length) throw new BadRequestException('有分组不存在，请刷新后重试');
      await this.assertNotSuppressed([contact.email]);
    }

    await this.prisma.$transaction(async (tx) => {
      if (unique.length > 0) {
        await tx.listMember.deleteMany({ where: { contactId: id, listId: { notIn: unique } } });
        await tx.listMember.createMany({
          data: unique.map((listId) => ({ contactId: id, listId })),
          skipDuplicates: true,
        });
      } else {
        await tx.listMember.deleteMany({ where: { contactId: id } });
      }
    });

    return { ok: true, listIds: unique };
  }

  /**
   * 删除联系人。
   *
   * 只删人，**不动抑制名单**：抑制记录是"这个地址确实不存在"的事实，
   * 一旦跟着删除，重新导入同一份名单就会把死地址放回来继续撞。
   * 投递明细靠 contactId 的 SetNull 保留，历史报表不受影响。
   */
  async remove(id: number) {
    await this.getOrThrow(id);
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * 批量调整分组：面板上勾一批人再统一改归属。
   * replace=true 先清空这些人原有的所有分组再写入（"改成这几个分组"），
   * false 只追加（"再加上这几个分组"）；listIds 为空 + replace 等于把他们移出全部分组。
   */
  async batchSetLists(ids: number[], listIds: number[], replace = false) {
    const contactIds = [...new Set(ids)].filter((n) => Number.isInteger(n));
    const targetLists = [...new Set(listIds)];
    if (contactIds.length === 0) return { updated: 0 };

    if (targetLists.length > 0) {
      const found = await this.prisma.list.count({ where: { id: { in: targetLists } } });
      if (found !== targetLists.length) throw new BadRequestException('有分组不存在，请刷新后重试');
    }

    const existing = await this.prisma.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, email: true },
    });
    const realIds = existing.map((c) => c.id);
    if (realIds.length === 0) return { updated: 0 };

    if (targetLists.length > 0) {
      await this.assertNotSuppressed(existing.map((c) => c.email));
    }

    await this.prisma.$transaction(async (tx) => {
      if (replace) {
        await tx.listMember.deleteMany({ where: { contactId: { in: realIds } } });
      }
      if (targetLists.length > 0) {
        // 笛卡尔积可能很大，分批写，避免单条 INSERT 参数爆掉
        for (const chunk of chunkArray(realIds, 200)) {
          await tx.listMember.createMany({
            data: chunk.flatMap((contactId) => targetLists.map((listId) => ({ contactId, listId }))),
            skipDuplicates: true,
          });
        }
      }
    });

    return { updated: realIds.length };
  }

  /** 批量删除（联系人页勾选后一次清掉）；返回值用于提示实际删了多少 */
  async batchRemove(ids: number[]) {
    const unique = [...new Set(ids)].filter((n) => Number.isInteger(n));
    if (unique.length === 0) return { deleted: 0 };

    const rows = await this.prisma.contact.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (rows.length === 0) return { deleted: 0 };

    // 抑制名单不动（同 remove 的理由）；分批删，避免 IN 参数超限
    for (const part of chunkArray(rows.map((r) => r.id), 500)) {
      await this.prisma.contact.deleteMany({ where: { id: { in: part } } });
    }
    return { deleted: rows.length };
  }

  /** 已被标记为"地址不存在"的地址不允许加回分组，否则分组人数会虚高 */
  private async assertNotSuppressed(emails: string[]) {
    if (emails.length === 0) return;
    const hit = await this.prisma.suppression.findFirst({
      where: { email: { in: emails } },
      select: { email: true },
    });
    if (hit) {
      throw new BadRequestException(`${hit.email} 已被标记为地址不存在，不能加入分组`);
    }
  }

  private async getOrThrow(id: number) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('联系人不存在');
    return c;
  }
}

/** 把数组切成固定大小的块，避免单条 SQL 参数过多 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
