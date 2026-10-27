import type { ReactNode } from 'react';
import { metrics, tokens } from '../theme';

/**
 * 区块：标题在卡片外面。
 *
 * 卡片自带的 header 会把标题关进边框里，和页面级标题混在一起分不清层级；
 * 统一改成「标题 + 说明在上、纯内容卡片在下」。
 *
 * 尺寸与 PageHeader 保持同一套节奏：标题 15/600、说明 12、两者间距 6、
 * 标题与卡片间距 12——全站任何一块区域都是这三行关系。
 */
export default function Section({
  title,
  desc,
  extra,
  children,
  style,
}: {
  title: ReactNode;
  desc?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: metrics.gridGutter,
          marginBottom: metrics.snug,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.4,
              color: tokens.ink,
            }}
          >
            {title}
          </h2>
          {desc ? (
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 12,
                lineHeight: 1.6,
                color: tokens.muted,
              }}
            >
              {desc}
            </p>
          ) : null}
        </div>
        {extra ? (
          <div
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: metrics.tight,
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
            }}
          >
            {extra}
          </div>
        ) : null}
      </div>
      <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0 }}>{children}</div>
    </section>
  );
}
