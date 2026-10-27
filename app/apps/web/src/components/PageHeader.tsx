import type { ReactNode } from 'react';
import { metrics, tokens } from '../theme';

/**
 * 页面标题区（唯一写法）。
 *
 * 原来七个页面各写一套：有的用 Space、有的用 div、有的 flex-start 有的 center，
 * 说明文字一会儿 12px 一会儿 13px，标题基线在不同页面之间会跳。
 * 这里统一为「主标题 20/600 + 说明 13 + 操作区右对齐」，
 * 并且和顶栏共用 56px 的轴线高度节奏。
 */
export default function PageHeader({
  title,
  desc,
  note,
  extra,
}: {
  title: ReactNode;
  desc?: ReactNode;
  /** 附注：放临时状态提示，例如「正在查看回收站」 */
  note?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: metrics.gridGutter,
        // 标题区与下方内容之间由 .page 的 gap 负责，这里只保证内部不贴边
        paddingBottom: 0,
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.3,
            color: tokens.ink,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h1>
        {desc ? (
          <p
            style={{
              margin: `${metrics.tight - 2}px 0 0`,
              fontSize: 13,
              lineHeight: 1.6,
              color: tokens.muted,
            }}
          >
            {desc}
          </p>
        ) : null}
        {note ? <div style={{ marginTop: metrics.tight }}>{note}</div> : null}
      </div>

      {extra ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: metrics.tight,
            flex: '0 0 auto',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {extra}
        </div>
      ) : null}
    </header>
  );
}
