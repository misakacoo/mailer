/**
 * 模板渲染。
 *
 * 两条硬规则：
 * 1. 所有变量取值必须做 HTML 转义。联系人姓名里带 < > & 会直接把邮件结构搞坏，
 *    更糟的是这属于内容注入，收件方可能据此判为可疑。
 * 2. 链接改写通过 rewriteLink 钩子注入，L4 阶段传空实现，L7 的点击追踪会接管。
 *    先留钩子是为了避免到追踪那层再回头重写整个渲染流程。
 */

export type LinkRewriter = (url: string) => string;

export interface RenderOptions {
  /** 点击追踪：改写正文里所有 http(s) 链接 */
  rewriteLink?: LinkRewriter;
  /** 打开追踪像素地址（完整 URL），为空则不加 */
  openPixelUrl?: string;
  /** 追加的页脚 HTML，为空则不加 */
  footerHtml?: string;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_.\u4e00-\u9fa5]+)\s*\}\}/g;

const ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return String(input ?? '').replace(/[&<>"']/g, (c) => ENTITY_MAP[c]);
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** 从模板里抽出用了哪些变量，用于提示"这个变量没数据" */
export function collectVariables(source: string): string[] {
  const found = new Set<string>();
  for (const m of String(source ?? '').matchAll(VAR_RE)) found.add(m[1]);
  return [...found];
}

/** 主题行是纯文本，不做 HTML 转义，但要压掉换行避免头部注入 */
export function renderSubject(template: string, vars: Record<string, string>): string {
  return String(template ?? '')
    .replace(VAR_RE, (_, key: string) => String(vars[key] ?? ''))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** 纯文本正文：保留换行，只替换变量 */
export function renderTextBody(template: string, vars: Record<string, string>): string {
  return String(template ?? '')
    .replace(VAR_RE, (_, key: string) => String(vars[key] ?? ''))
    .trim();
}

function rewriteLinks(html: string, rewrite?: LinkRewriter): string {
  if (!rewrite) return html;
  return html.replace(/href\s*=\s*"([^"]*)"/gi, (whole, url: string) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      return whole;
    }
    if (!/^https?:\/\//i.test(trimmed)) return whole;
    // 已被处理过的不再重复改写
    if (/\/t\/c\//.test(trimmed)) return whole;
    return `href="${rewrite(trimmed)}"`;
  });
}

export function renderHtml(template: string, vars: Record<string, string>, opts: RenderOptions = {}): string {
  let html = String(template ?? '').replace(VAR_RE, (_, key: string) =>
    // 变量一律转义：既防结构破坏，也防内容注入
    escapeHtml(String(vars[key] ?? '')),
  );

  html = rewriteLinks(html, opts.rewriteLink);

  if (opts.openPixelUrl) {
    html += `\n<img src="${escapeHtml(opts.openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;text-decoration:none" />`;
  }

  if (opts.footerHtml) {
    html += `\n${opts.footerHtml}`;
  }

  return html;
}

/**
 * HTML → 纯文本。
 * 邮件必须带 text/plain 分支：只有 HTML 的单部分邮件在垃圾邮件评分里明显吃亏。
 */
export function htmlToText(html: string): string {
  let s = String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<hr[^>]*>/gi, '\n----\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[${alt}]` : ''))
    .replace(/<img[^>]*>/gi, '');

  // 链接保留目标地址，纯文本读者也能复制
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const text = String(label).replace(/<[^>]+>/g, '').trim();
    if (!text) return href && !href.startsWith('#') ? href : '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return text;
    return `${text} (${href})`;
  });

  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);

  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把联系人记录转成渲染用的变量表 */
export function buildVars(
  contact?: { email?: string | null; name?: string | null; fields?: unknown } | null,
  extra?: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    email: contact?.email ?? '',
    name: contact?.name ?? '',
    date: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    year: String(new Date().getFullYear()),
  };

  const fields = contact?.fields;
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      vars[k] = v === null || v === undefined ? '' : String(v);
    }
  }

  return { ...vars, ...(extra ?? {}) };
}
