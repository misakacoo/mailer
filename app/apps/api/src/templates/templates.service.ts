import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { APP_CONFIG, AppConfig } from '../common/config';
import { PrismaService } from '../common/prisma.service';
import { sanitizeSubject, sanitizeTemplateHtml } from './sanitize';

/** 附件扩展名 -> 服务端认定的 MIME。不在表里的类型一律拒绝。 */
const ALLOWED_ATTACHMENT_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};
import { MailService, OutgoingAttachment } from '../mail/mail.service';
import {
  buildVars,
  collectVariables,
  htmlToText,
  renderHtml,
  renderSubject,
  renderTextBody,
} from './render';
import {
  CreateTemplateDto,
  PreviewDto,
  TestSendTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly mail: MailService,
  ) {}

  async list(includeDeleted = false) {
    const rows = await this.prisma.template.findMany({
      where: includeDeleted ? { deletedAt: { not: null } } : { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      subject: t.subject,
      trackOpen: t.trackOpen,
      trackClick: t.trackClick,
      attachmentCount: t.attachmentIds.length,
      updatedAt: t.updatedAt.toISOString(),
      deletedAt: t.deletedAt?.toISOString() ?? null,
    }));
  }

  async get(id: number) {
    const t = await this.prisma.template.findFirst({ where: { id, deletedAt: null } });
    if (!t) throw new NotFoundException('模板不存在');
    return {
      id: t.id,
      name: t.name,
      subject: t.subject,
      html: t.html,
      text: t.text,
      trackOpen: t.trackOpen,
      trackClick: t.trackClick,
      attachmentIds: t.attachmentIds,
      variables: collectVariables(`${t.subject} ${t.html} ${t.text ?? ''}`),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  async create(dto: CreateTemplateDto) {
    const created = await this.prisma.template.create({
      data: {
        name: dto.name.trim(),
        subject: sanitizeSubject(dto.subject),
        // 入库前净化：模板 HTML 会被写回面板的 contentEditable，
        // 带事件属性的内容等于同源执行脚本
        html: sanitizeTemplateHtml(dto.html ?? ''),
        text: dto.text?.trim() || null,
        trackOpen: dto.trackOpen ?? true,
        trackClick: dto.trackClick ?? true,
        attachmentIds: dto.attachmentIds ?? [],
      },
    });
    return { id: created.id };
  }

  async update(id: number, dto: UpdateTemplateDto) {
    await this.getOrThrow(id);
    await this.prisma.template.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.subject !== undefined ? { subject: sanitizeSubject(dto.subject) } : {}),
        ...(dto.html !== undefined ? { html: sanitizeTemplateHtml(dto.html) } : {}),
        ...(dto.text !== undefined ? { text: dto.text?.trim() || null } : {}),
        ...(dto.trackOpen !== undefined ? { trackOpen: dto.trackOpen } : {}),
        ...(dto.trackClick !== undefined ? { trackClick: dto.trackClick } : {}),
        ...(dto.attachmentIds !== undefined ? { attachmentIds: dto.attachmentIds } : {}),
      },
    });
    return { ok: true };
  }

  /** 删除 = 进回收站；被未删除的任务引用时仍然拦下来 */
  async remove(id: number) {
    await this.getOrThrow(id);
    const used = await this.prisma.campaign.count({ where: { templateId: id, deletedAt: null } });
    if (used > 0) {
      throw new BadRequestException(`该模板已被 ${used} 个任务引用，不能删除。可以改名或另存副本。`);
    }
    await this.prisma.template.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true, softDeleted: true };
  }

  async restore(id: number) {
    const t = await this.prisma.template.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('模板不存在');
    if (!t.deletedAt) return { ok: true, already: true };
    await this.prisma.template.update({ where: { id }, data: { deletedAt: null } });
    return { ok: true };
  }

  async purge(id: number) {
    const t = await this.prisma.template.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('模板不存在');
    if (!t.deletedAt) throw new BadRequestException('请先删除到回收站，再彻底删除');
    const used = await this.prisma.campaign.count({ where: { templateId: id } });
    if (used > 0) {
      throw new BadRequestException(`仍有 ${used} 个任务（含回收站里的）引用该模板，无法彻底删除`);
    }
    await this.prisma.template.delete({ where: { id } });
    return { ok: true };
  }

  async duplicate(id: number) {
    const t = await this.getOrThrow(id);
    const created = await this.prisma.template.create({
      data: {
        name: `${t.name} 副本`,
        subject: t.subject,
        html: t.html,
        text: t.text,
        trackOpen: t.trackOpen,
        trackClick: t.trackClick,
        attachmentIds: t.attachmentIds,
      },
    });
    return { id: created.id };
  }

  /**
   * 预览不落库、不加追踪像素、不改写链接。
   * 改写链接会让预览里的 URL 变成追踪地址，看着像坏了。
   */
  async preview(dto: PreviewDto) {
    const vars = buildVars(dto.sample ?? null);
    const subject = renderSubject(dto.subject, vars);
    const html = renderHtml(dto.html, vars, {});
    const text = dto.text?.trim() ? renderTextBody(dto.text, vars) : htmlToText(html);

    const used = collectVariables(`${dto.subject} ${dto.html}`);
    const missing = used.filter((k) => vars[k] === undefined);

    return {
      subject,
      html,
      text,
      variables: used,
      missingVariables: missing,
      size: { html: html.length, text: text.length },
    };
  }

  /** 测试发送：渲染时关闭追踪，避免收到一堆指向不存在收件人的追踪链接 */
  async testSend(id: number, dto: TestSendTemplateDto) {
    const t = await this.getOrThrow(id);

    const sample = dto.sample ?? { email: dto.to, name: '测试联系人' };
    const vars = buildVars(sample);
    const subject = renderSubject(t.subject, vars);
    const html = renderHtml(t.html, vars, {});
    const text = t.text?.trim() ? renderTextBody(t.text, vars) : htmlToText(html);

    const attachments = await this.loadAttachments(t.attachmentIds);

    const result = await this.mail.send(dto.channelId, {
      to: dto.to,
      subject,
      html,
      text,
      attachments,
    });

    return { ...result, renderedSubject: subject, attachmentCount: attachments.length };
  }

  // ---------- 附件 ----------

  async uploadAttachment(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择文件');
    if (file.size === 0) throw new BadRequestException('文件是空的');

    // 只允许这些能被收件人安全打开的附件类型：
    // 放行 html/svg/exe 等于把钓鱼页直接送到对方邮箱，也会拖垮发信域名声誉
    const ext = extname(file.originalname).toLowerCase();
    const allowed = ALLOWED_ATTACHMENT_EXT[ext];
    if (!allowed) {
      throw new BadRequestException(`不支持的文件类型（${ext || '无扩展名'}）`);
    }
    const stored = `${randomUUID()}${ext}`;
    const fullPath = join(this.cfg.uploadDir, stored);

    await writeFile(fullPath, file.buffer);

    const row = await this.prisma.attachment.create({
      data: {
        // 去掉路径分隔符与控制字符，避免收件端保存时出现问题
        filename: file.originalname.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200),
        // MIME 由服务端按白名单推导，不信任客户端声明
        mime: allowed,
        size: file.size,
        path: fullPath,
      },
    });

    return { id: row.id, filename: row.filename, size: row.size, mime: row.mime };
  }

  async listAttachments() {
    const rows = await this.prisma.attachment.findMany({ orderBy: { id: 'desc' }, take: 100 });
    return rows.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mime: a.mime }));
  }

  async removeAttachment(id: number) {
    const row = await this.prisma.attachment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('附件不存在');
    await unlink(row.path).catch(() => undefined);
    await this.prisma.attachment.delete({ where: { id } });
    return { ok: true };
  }

  private async loadAttachments(ids: number[]): Promise<OutgoingAttachment[]> {
    if (!ids?.length) return [];
    const rows = await this.prisma.attachment.findMany({ where: { id: { in: ids } } });
    return rows.map((a) => ({ filename: a.filename, path: a.path, contentType: a.mime }));
  }

  private async getOrThrow(id: number) {
    const t = await this.prisma.template.findFirst({ where: { id, deletedAt: null } });
    if (!t) throw new NotFoundException('模板不存在');
    return t;
  }
}
