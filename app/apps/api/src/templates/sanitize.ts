/**
 * 邮件模板 HTML 净化。
 *
 * 模板是"用户写的 HTML"，但前端编辑器会把它写回 contentEditable，
 * 一旦粘进带 `onerror` 的内容，就等于在面板同源里执行了脚本。
 * 这里在入库前做一次白名单清洗：删脚本、删事件属性、删危险协议。
 *
 * 不做完整的 HTML 解析（Node 端没有 DOM，引 sanitize-html 又要加依赖），
 * 所以用"先删危险块、再逐标签过滤、循环到稳定"的策略：
 * 关键是循环——只做一次替换时 `<scr<script>ipt>` 会被还原成 `<script>`。
 */
const BLOCK_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'];

/** 允许保留的属性（其余一律删除，包括 data-* 之外的未知属性） */
const ALLOWED_ATTR = /^(href|src|alt|title|width|height|style|class|align|valign|colspan|rowspan|border|cellpadding|cellspacing|bgcolor|color|face|size|target|rel|name|type|value|checked|selected|disabled|dir|id)$/i;

function stripBlocks(html: string): string {
  let out = html;
  for (const tag of BLOCK_TAGS) {
    // 成对出现的块（含内容）
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // 自闭合 / 未闭合的单个标签
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  return out;
}

function filterTags(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g, (whole, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    const closing = whole.startsWith('</');
    if (closing) return `</${tag}>`;

    const attrs = rawAttrs
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript|data:text\/html)[^\s>]*)/gi, '')
      .split(/\s+/)
      .filter((chunk) => {
        if (!chunk) return false;
        const name = chunk.split('=')[0];
        return ALLOWED_ATTR.test(name);
      })
      .join(' ');

    const selfClose = /\/>$/.test(whole) ? ' /' : '';
    return `<${tag}${attrs ? ' ' + attrs : ''}${selfClose}>`;
  });
}

function stripProtocols(html: string): string {
  return html
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '');
}

export function sanitizeTemplateHtml(input: string): string {
  let out = String(input ?? '');
  // 循环到稳定：单次替换可被嵌套写法绕过
  for (let i = 0; i < 4; i++) {
    const next = stripProtocols(filterTags(stripBlocks(out)));
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 主题不允许多行，也不允许 CRLF 注入头 */
export function sanitizeSubject(input: string): string {
  return String(input ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}
