import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImportJob } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { log } from '../../common/logger';
import { PrismaService } from '../../common/prisma.service';
import { ColumnMapping, ParsedTable, SUPPORTED_EXT, parseTabular, suggestMapping } from './parser';

export interface ImportReport {
  total: number;
  imported: number;
  existing: number;
  addedToList: number;
  invalid: number;
  duplicateInFile: number;
  suppressed: number;
  empty: number;
  samples: {
    invalid: string[];
    duplicateInFile: string[];
    suppressed: string[];
  };
}

export type ImportSamples = ImportReport['samples'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** 每个分块处理多少行：太大则暂停/取消响应慢，太小则事务开销占比高 */
const IMPORT_CHUNK = 500;
const STALE_MS = 2 * 60 * 60 * 1000;
const EMPTY_SAMPLES: ImportSamples = { invalid: [], duplicateInFile: [], suppressed: [] };

function normalizeEmail(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/[<>"'\s]/g, '');
}

function mergeSamples(base: ImportSamples | null, add: ImportSamples): ImportSamples {
  const merge = (a: string[] | undefined, b: string[], cap = 5) => {
    const out = [...(a ?? [])];
    for (const x of b) {
      if (out.length >= cap) break;
      out.push(x);
    }
    return out;
  };
  return {
    invalid: merge(base?.invalid, add.invalid),
    duplicateInFile: merge(base?.duplicateInFile, add.duplicateInFile),
    suppressed: merge(base?.suppressed, add.suppressed),
  };
}

@Injectable()
export class ImportService {
  /**
   * 解析结果缓存：XLSX 解析不便宜，
   * 断点续传时如果每推进 500 行就把整个文件重新解析一遍，导入会慢得没法看。
   * 只缓存最新一个任务的解析结果——同时跑多个导入的场景不需要为它做 LRU。
   */
  private tableCache = new Map<number, { table: ParsedTable }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private filePath(token: string) {
    return join(this.cfg.tmpDir, `import-${token}.bin`);
  }

  private metaPath(token: string) {
    return join(this.cfg.tmpDir, `import-${token}.json`);
  }

  private async cleanupFiles(token: string) {
    await unlink(this.filePath(token)).catch(() => undefined);
    await unlink(this.metaPath(token)).catch(() => undefined);
  }

  /**
   * 暂存文件两小时后自动清掉，避免 tmp 目录被上传文件堆满。
   * 有活跃导入任务的文件必须豁免——大文件导入可能一暂停就是几个小时。
   */
  private async sweepStale() {
    try {
      const active = await this.prisma.importJob.findMany({
        where: { status: { in: ['pending', 'running', 'paused'] } },
        select: { token: true },
      });
      const activeTokens = new Set(active.map((a) => a.token));

      const files = await readdir(this.cfg.tmpDir);
      const now = Date.now();
      for (const f of files) {
        if (!f.startsWith('import-')) continue;
        const token = f.slice('import-'.length).replace(/\.(bin|json)$/, '');
        if (activeTokens.has(token)) continue;
        const p = join(this.cfg.tmpDir, f);
        const st = await stat(p).catch(() => null);
        if (st && now - st.mtimeMs > STALE_MS) await unlink(p).catch(() => undefined);
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  async preview(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择要上传的文件');

    const ext = (file.originalname.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      throw new BadRequestException(`只支持 ${SUPPORTED_EXT.join(' / ')} 格式`);
    }
    if (file.size === 0) throw new BadRequestException('文件是空的');

    let table: ParsedTable;
    try {
      table = parseTabular(file.buffer, file.originalname);
    } catch (e: any) {
      throw new BadRequestException(`解析失败：${e?.message ?? '文件格式可能已损坏'}`);
    }

    if (table.rows.length === 0) {
      throw new BadRequestException('文件里没有解析到任何数据行');
    }

    await this.sweepStale();

    const token = randomUUID();
    await writeFile(this.filePath(token), file.buffer);
    await writeFile(
      this.metaPath(token),
      JSON.stringify({ ext, originalName: file.originalname, size: file.size, uploadedAt: Date.now() }),
    );

    return {
      token,
      filename: file.originalname,
      ext,
      size: file.size,
      encoding: table.encoding,
      sheetName: table.sheetName,
      hasHeader: table.hasHeader,
      columns: table.columns,
      totalRows: table.totalRows,
      suggested: suggestMapping(table),
      sample: table.rows.slice(0, 8),
      warnings: table.warnings,
    };
  }

  /**
   * 创建导入任务。只做校验和建档，不处理任何行——
   * 处理交给 worker 的分块循环，HTTP 请求立即返回。
   */
  async startJob(token: string, listId: number, mapping: ColumnMapping) {
    if (!token) throw new BadRequestException('缺少导入令牌，请重新上传文件');
    if (!Number.isInteger(listId)) throw new BadRequestException('请选择要导入的分组');
    if (
      mapping?.emailColumn === undefined ||
      mapping.emailColumn < 0 ||
      !Number.isInteger(mapping.emailColumn)
    ) {
      throw new BadRequestException('请指定邮箱所在的列');
    }

    const list = await this.prisma.list.findUnique({ where: { id: listId } });
    if (!list) throw new NotFoundException('目标分组不存在');

    let meta: { originalName: string; ext: string; size: number };
    let buf: Buffer;
    try {
      meta = JSON.parse(await readFile(this.metaPath(token), 'utf8'));
      buf = await readFile(this.filePath(token));
    } catch {
      throw new BadRequestException('上传的文件已过期，请重新上传');
    }

    const table = parseTabular(buf, meta.originalName);
    if (mapping.emailColumn >= table.columns.length) {
      throw new BadRequestException('邮箱列超出文件列数，请重新选择');
    }

    const job = await this.prisma.importJob.create({
      data: {
        token,
        filename: meta.originalName,
        ext: meta.ext ?? '',
        size: meta.size ?? buf.length,
        listId,
        mapping: mapping as any,
        totalRows: table.rows.length,
        status: 'pending',
      },
    });

    log.info({ jobId: job.id, totalRows: table.rows.length, listId }, '导入任务已创建');
    return { id: job.id, totalRows: table.rows.length, listId };
  }

  async listJobs(limit = 20) {
    const rows = await this.prisma.importJob.findMany({
      orderBy: { id: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
    return rows.map((j) => this.toView(j));
  }

  async getJob(id: number) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('导入任务不存在');
    return this.toView(job);
  }

  /** 暂停：游标停在当前分块边界，随时可以继续 */
  async pause(id: number) {
    const res = await this.prisma.importJob.updateMany({
      where: { id, status: 'running' },
      data: { status: 'paused' },
    });
    if (res.count === 0) throw new BadRequestException('只有进行中的任务可以暂停');
    return { ok: true };
  }

  async resume(id: number) {
    const res = await this.prisma.importJob.updateMany({
      where: { id, status: 'paused' },
      data: { status: 'running' },
    });
    if (res.count === 0) throw new BadRequestException('只有已暂停的任务可以继续');
    return { ok: true };
  }

  /** 取消：未处理的行不再处理；已入库的联系人和分组关系保留（导入本身是幂等的） */
  async cancel(id: number) {
    const res = await this.prisma.importJob.updateMany({
      where: { id, status: { in: ['pending', 'running', 'paused'] } },
      data: { status: 'canceled' },
    });
    if (res.count === 0) throw new BadRequestException('任务已结束，无法取消');
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (job) {
      await this.cleanupFiles(job.token);
      this.tableCache.delete(job.id);
    }
    return { ok: true, processedRows: job?.processedRows ?? 0 };
  }

  // ---------- worker 侧：分块推进 ----------

  /**
   * worker 每轮循环调用一次。有进行中的任务就推进一个分块，返回是否干了活。
   *
   * 断点续传的关键：分块处理和游标推进在同一个事务里。
   * 进程崩在半路，这一块要么整体生效、要么整体重来——游标之后的行会被重新处理，
   * 而联系人/分组的写入全部带 skipDuplicates，重跑不会产生脏数据。
   */
  async tick(): Promise<boolean> {
    // pending → running：由 worker 在场时认领，而不是创建时就置 running。
    // 否则 worker 不在线时任务卡死在 pending；反过来 worker 一启动就自动接管。
    const promoted = await this.prisma.importJob.updateMany({
      where: { status: 'pending' },
      data: { status: 'running' },
    });
    if (promoted.count > 0) log.info({ count: promoted.count }, '开始处理导入任务');

    const job = await this.prisma.importJob.findFirst({
      where: { status: 'running' },
      orderBy: { id: 'asc' },
    });
    if (!job) return false;

    try {
      await this.processChunk(job);
    } catch (e: any) {
      const message = e?.message ?? String(e);
      log.error({ jobId: job.id, err: message }, '导入任务失败');
      await this.prisma.importJob
        .update({ where: { id: job.id }, data: { status: 'failed', error: message.slice(0, 500) } })
        .catch(() => undefined);
      await this.cleanupFiles(job.token);
      this.tableCache.delete(job.id);
    }
    return true;
  }

  private async tableFor(job: ImportJob): Promise<ParsedTable> {
    const cached = this.tableCache.get(job.id);
    if (cached) return cached.table;

    const meta = JSON.parse(await readFile(this.metaPath(job.token), 'utf8'));
    const buf = await readFile(this.filePath(job.token));
    const table = parseTabular(buf, meta.originalName ?? job.filename);
    this.tableCache.clear();
    this.tableCache.set(job.id, { table });
    return table;
  }

  private async processChunk(job: ImportJob): Promise<void> {
    const table = await this.tableFor(job);
    const mapping = job.mapping as unknown as ColumnMapping;

    const start = job.processedRows;
    if (start >= table.rows.length) {
      await this.finish(job);
      return;
    }
    const end = Math.min(table.rows.length, start + IMPORT_CHUNK);

    // 本块内去重；跨块的重复由库内唯一约束兜住，会计入「已在库中」而不是「文件内重复」
    const seen = new Set<string>();
    const candidates: { email: string; name: string | null; fields: Record<string, string> }[] = [];
    let invalid = 0;
    let duplicate = 0;
    let empty = 0;
    let suppressed = 0;
    const samples: ImportSamples = { invalid: [], duplicateInFile: [], suppressed: [] };

    for (let i = start; i < end; i++) {
      const row = table.rows[i];
      const email = normalizeEmail(row[mapping.emailColumn] ?? '');
      if (!email) {
        empty++;
        continue;
      }
      if (!EMAIL_RE.test(email)) {
        invalid++;
        if (samples.invalid.length < 5) samples.invalid.push(email.slice(0, 80));
        continue;
      }
      if (seen.has(email)) {
        duplicate++;
        if (samples.duplicateInFile.length < 5) samples.duplicateInFile.push(email);
        continue;
      }
      seen.add(email);

      const name =
        mapping.nameColumn !== null && mapping.nameColumn !== undefined
          ? String(row[mapping.nameColumn] ?? '').trim() || null
          : null;

      const fields: Record<string, string> = {};
      for (const extra of mapping.extraColumns ?? []) {
        if (extra.index === mapping.emailColumn) continue;
        const key = String(extra.key ?? '').trim();
        const value = String(row[extra.index] ?? '').trim();
        if (key && value) fields[key] = value;
      }
      candidates.push({ email, name, fields });
    }

    const emails = candidates.map((c) => c.email);
    const [existingRows, suppressedRows] = await Promise.all([
      this.prisma.contact.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } }),
      this.prisma.suppression.findMany({ where: { email: { in: emails } }, select: { email: true } }),
    ]);
    const existingMap = new Map(existingRows.map((c) => [c.email, c.id]));
    const suppressedSet = new Set(suppressedRows.map((s) => s.email));

    for (const c of candidates) {
      if (suppressedSet.has(c.email)) {
        suppressed++;
        if (samples.suppressed.length < 5) samples.suppressed.push(c.email);
      }
    }

    const toCreate = candidates.filter((c) => !existingMap.has(c.email) && !suppressedSet.has(c.email));
    let imported = 0;
    let addedToList = 0;
    // 既不在抑制名单、也不是本块新建的，就是库里已有的
    let existCount = candidates.length - toCreate.length - suppressed;

    await this.prisma.$transaction(async (tx) => {
      // 块边界复查状态：暂停/取消最迟在这里生效。游标不动，已处理的行不回滚
      const cur = await tx.importJob.findUnique({ where: { id: job.id }, select: { status: true } });
      if (!cur || cur.status !== 'running') return;

      if (toCreate.length > 0) {
        const res = await tx.contact.createMany({
          data: toCreate.map((c) => ({
            email: c.email,
            name: c.name,
            fields: c.fields,
            source: job.filename,
          })),
          skipDuplicates: true,
        });
        imported = res.count;
      }

      const contactRows =
        emails.length > 0
          ? await tx.contact.findMany({
              where: { email: { in: emails.filter((e) => !suppressedSet.has(e)) } },
              select: { id: true },
            })
          : [];
      if (contactRows.length > 0) {
        // 按 createMany 的返回条数计，而不是查询条数：skipDuplicates 会跳过已在分组里的人
        const res = await tx.listMember.createMany({
          data: contactRows.map((c) => ({ listId: job.listId, contactId: c.id })),
          skipDuplicates: true,
        });
        addedToList = res.count;
      }

      await tx.importJob.update({
        where: { id: job.id },
        data: {
          processedRows: end,
          imported: job.imported + imported,
          existing: job.existing + existCount,
          addedToList: job.addedToList + addedToList,
          invalid: job.invalid + invalid,
          duplicateInFile: job.duplicateInFile + duplicate,
          suppressed: job.suppressed + suppressed,
          empty: job.empty + empty,
          samples: mergeSamples(job.samples as ImportSamples | null, samples) as any,
        },
      });
    });

    if (end >= table.rows.length) {
      const latest = await this.prisma.importJob.findUnique({ where: { id: job.id } });
      if (latest && latest.status === 'running') await this.finish(latest);
    }
  }

  private async finish(job: ImportJob) {
    await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'done' } });
    await this.cleanupFiles(job.token);
    this.tableCache.delete(job.id);
    log.info(
      { jobId: job.id, total: job.totalRows, imported: job.imported, existing: job.existing },
      '导入任务完成',
    );
  }

  private toView(j: ImportJob) {
    return {
      id: j.id,
      filename: j.filename,
      size: j.size,
      listId: j.listId,
      totalRows: j.totalRows,
      processedRows: j.processedRows,
      imported: j.imported,
      existing: j.existing,
      addedToList: j.addedToList,
      invalid: j.invalid,
      duplicateInFile: j.duplicateInFile,
      suppressed: j.suppressed,
      empty: j.empty,
      samples: (j.samples as ImportSamples | null) ?? EMPTY_SAMPLES,
      status: j.status,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    };
  }
}
