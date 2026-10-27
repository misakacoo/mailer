import { extname } from 'node:path';
import iconv from 'iconv-lite';
import * as XLSX from 'xlsx';

export interface ParsedTable {
  encoding: string;
  sheetName: string | null;
  columns: string[];
  rows: string[][];
  totalRows: number;
  hasHeader: boolean;
  warnings: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@,]+\.[^\s@,]{2,}$/;

const EMAIL_HINTS = ['email', 'e-mail', 'emailaddress', 'mail', 'mailbox', '邮箱', '电子邮箱', '电子邮件', '邮件', '邮件地址', '地址', '电邮'];
const NAME_HINTS = ['name', 'fullname', '姓名', '名字', '昵称', '联系人', '客户名'];
const OTHER_HINTS = ['company', '公司', '企业', '单位', 'phone', 'mobile', 'tel', '手机', '电话', '手机号', '联系电话', 'title', '职位', '职务'];

/** 国内 CSV 大量是 GBK 编码，直接按 UTF-8 读会得到满屏乱码 */
function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' };
  }
}

function norm(s: string): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(String(s ?? '').trim());
}

function detectDelimiter(lines: string[]): string | null {
  const counts: Record<string, number> = { '\t': 0, ',': 0, ';': 0, '|': 0 };
  for (const line of lines.slice(0, 30)) {
    for (const d of Object.keys(counts)) {
      counts[d] += line.split(d).length - 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

function splitLine(line: string, delimiter: string | null): string[] {
  if (!delimiter) return [line.trim()];
  // 轻量 CSV 解析：支持双引号包裹与转义引号
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** 第一行是表头还是数据？单邮箱列的 TXT 第一行本身就是邮箱，不能当表头吃掉 */
function detectHeader(firstRow: string[]): boolean {
  if (!firstRow || firstRow.length === 0) return false;
  if (firstRow.some((c) => looksLikeEmail(c))) return false;
  const hints = new Set([...EMAIL_HINTS, ...NAME_HINTS, ...OTHER_HINTS]);
  const hit = firstRow.some((c) => hints.has(norm(c)));
  if (hit) return true;
  // 没有任何提示词、也不含邮箱：多半仍是表头（如 "字段1,字段2"）
  return true;
}

function buildColumns(headerRow: string[], width: number): string[] {
  const cols: string[] = [];
  for (let i = 0; i < width; i++) {
    const raw = String(headerRow?.[i] ?? '').trim();
    cols.push(raw || `列${i + 1}`);
  }
  // 表头重名时补序号，否则自定义字段会互相覆盖
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}_${n}`;
  });
}

function finalize(matrix: string[][], meta: { encoding: string; sheetName: string | null; warnings: string[] }): ParsedTable {
  const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  if (width === 0) {
    return {
      encoding: meta.encoding,
      sheetName: meta.sheetName,
      columns: [],
      rows: [],
      totalRows: 0,
      hasHeader: false,
      warnings: [...meta.warnings, '文件里没有读到任何数据'],
    };
  }

  const firstRow = matrix[0] ?? [];
  const hasHeader = detectHeader(firstRow);

  const columns = hasHeader ? buildColumns(firstRow, width) : Array.from({ length: width }, (_, i) => `列${i + 1}`);
  const bodyRows = hasHeader ? matrix.slice(1) : matrix;

  const rows = bodyRows
    .map((r) => {
      const filled = [...r];
      while (filled.length < width) filled.push('');
      return filled.slice(0, width).map((c) => String(c ?? '').trim());
    })
    .filter((r) => r.some((c) => c !== ''));

  const warnings = [...meta.warnings];
  if (!hasHeader) warnings.push('未识别到表头，已按「列1、列2…」命名，请在下一步指定邮箱所在列');

  return {
    encoding: meta.encoding,
    sheetName: meta.sheetName,
    columns,
    rows,
    totalRows: rows.length,
    hasHeader,
    warnings,
  };
}

function parseTextFile(buf: Buffer, delimiter: string | null): ParsedTable {
  const { text, encoding } = decodeText(buf);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return finalize([], { encoding, sheetName: null, warnings: [] });

  const realDelimiter = delimiter ?? detectDelimiter(lines);
  const matrix = lines.map((l) => splitLine(l, realDelimiter));
  return finalize(matrix, { encoding, sheetName: null, warnings: [] });
}

/** XLSX / XLS：读第一个工作表 */
function parseWorkbook(buf: Buffer): ParsedTable {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellText: true });
  if (wb.SheetNames.length === 0) {
    return finalize([], { encoding: 'binary', sheetName: null, warnings: ['工作簿里没有工作表'] });
  }
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  const matrix = (aoa as unknown[][]).map((row) => (row ?? []).map((c) => String(c ?? '').trim()));
  const warnings: string[] = [];
  if (wb.SheetNames.length > 1) {
    warnings.push(`工作簿有 ${wb.SheetNames.length} 个工作表，只导入了第一个「${sheetName}」`);
  }
  return finalize(matrix, { encoding: 'binary', sheetName, warnings });
}

/** CSV：先解码再用 xlsx 解析，兼顾 GBK 与引号转义 */
function parseCsv(buf: Buffer): ParsedTable {
  const { text, encoding } = decodeText(buf);
  const wb = XLSX.read(text, { type: 'string', raw: false });
  const sheetName = wb.SheetNames[0] ?? null;
  const ws = sheetName ? wb.Sheets[sheetName] : null;
  const aoa = ws ? XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: false }) : [];
  const matrix = (aoa as unknown[][]).map((row) => (row ?? []).map((c) => String(c ?? '').trim()));
  return finalize(matrix, { encoding, sheetName: null, warnings: [] });
}

export function parseTabular(buf: Buffer, filename: string): ParsedTable {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.xlsx':
    case '.xls':
      return parseWorkbook(buf);
    case '.csv':
      return parseCsv(buf);
    case '.txt':
      return parseTextFile(buf, null);
    default:
      throw new Error(`不支持的文件类型：${ext || '(无扩展名)'}`);
  }
}

export const SUPPORTED_EXT = ['.csv', '.xlsx', '.xls', '.txt'];

export interface ColumnMapping {
  emailColumn: number;
  nameColumn: number | null;
  extraColumns: { index: number; key: string }[];
}

/** 猜一份映射：优先按表头关键词，其次按前 50 行里邮箱形态的命中率 */
export function suggestMapping(table: ParsedTable): ColumnMapping {
  const lower = table.columns.map((c) => norm(c));

  let emailColumn = lower.findIndex((c) => EMAIL_HINTS.includes(c));
  if (emailColumn < 0) emailColumn = lower.findIndex((c) => EMAIL_HINTS.some((h) => c.includes(h)));

  let nameColumn = lower.findIndex((c) => NAME_HINTS.includes(c));
  if (nameColumn < 0) nameColumn = lower.findIndex((c) => NAME_HINTS.some((h) => c.includes(h)));

  if (emailColumn < 0) {
    const sample = table.rows.slice(0, 50);
    let best = -1;
    let bestHit = 0;
    for (let i = 0; i < table.columns.length; i++) {
      const hits = sample.filter((r) => looksLikeEmail(r[i] ?? '')).length;
      if (hits > bestHit) {
        bestHit = hits;
        best = i;
      }
    }
    if (best >= 0 && bestHit > 0) emailColumn = best;
  }

  const extraColumns = table.columns
    .map((c, i) => ({ index: i, key: c }))
    .filter((c) => c.index !== emailColumn && c.index !== nameColumn && !/^列\d+$/.test(c.key));

  return {
    emailColumn: emailColumn >= 0 ? emailColumn : 0,
    nameColumn: nameColumn >= 0 ? nameColumn : null,
    extraColumns,
  };
}
