import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateListDto, UpdateListDto } from './dto/list.dto';

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
      contactCount: l._count.members,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  async create(dto: CreateListDto) {
    const created = await this.prisma.list.create({
      data: { name: dto.name.trim(), description: dto.description?.trim() || null },
    });
    return { id: created.id, name: created.name, description: created.description, contactCount: 0 };
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
      contactCount: updated._count.members,
    };
  }

  /** 删除分组只断开关联，联系人本身保留 */
  async remove(id: number) {
    await this.getOrThrow(id);
    await this.prisma.list.delete({ where: { id } });
    return { ok: true };
  }

  private async getOrThrow(id: number) {
    const list = await this.prisma.list.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('分组不存在');
    return list;
  }
}
