import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateContactDto, QueryContactsDto, UpdateContactDto } from './dto/contact.dto';

function normalizeEmail(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/[<>"'\s]/g, '');
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

    return {
      items: rows.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        fields: c.fields,
        source: c.source,
        createdAt: c.createdAt.toISOString(),
        lists: c.listMembers.map((m) => m.list),
      })),
      total,
      page,
      pageSize,
    };
  }

  async stats() {
    const [total, suppressed] = await Promise.all([
      this.prisma.contact.count(),
      this.prisma.suppression.count(),
    ]);
    return { total, suppressed };
  }

  async create(dto: CreateContactDto) {
    const email = normalizeEmail(dto.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    const exists = await this.prisma.contact.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('该邮箱已存在');

    const created = await this.prisma.contact.create({
      data: {
        email,
        name: dto.name?.trim() || null,
        fields: dto.fields ?? {},
        source: 'manual',
        ...(dto.listId ? { listMembers: { create: [{ listId: dto.listId }] } } : {}),
      },
    });
    return { id: created.id, email: created.email };
  }

  async update(id: number, dto: UpdateContactDto) {
    await this.getOrThrow(id);
    const updated = await this.prisma.contact.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name?.trim() || null } : {}),
        ...(dto.fields !== undefined ? { fields: dto.fields } : {}),
      },
    });
    return { id: updated.id, email: updated.email };
  }

  /**
   * 替换联系人的分组归属。
   * 之前只能在新建联系人或导入时指定分组，老联系人无法在 UI 上加入新分组。
   */
  async setLists(id: number, listIds: number[]) {
    await this.getOrThrow(id);
    const unique = [...new Set(listIds)];

    if (unique.length > 0) {
      const found = await this.prisma.list.count({ where: { id: { in: unique } } });
      if (found !== unique.length) throw new BadRequestException('有分组不存在，请刷新后重试');
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
   * 有投递历史的联系人不允许物理删除——删掉会把 recipients 一起级联清空，
   * 历史统计数据就再也对不上了。这种情况应该改成「退订」。
   */
  async remove(id: number) {
    await this.getOrThrow(id);
    const history = await this.prisma.recipient.count({ where: { contactId: id } });
    if (history > 0) {
      throw new BadRequestException(
        `该联系人有 ${history} 条投递记录，删除会一并清空历史。如果只是不想再发给他，可以把他移出所有分组。`,
      );
    }
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }

  private async getOrThrow(id: number) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('联系人不存在');
    return c;
  }
}
