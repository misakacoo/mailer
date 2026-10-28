import type { ReactNode } from 'react';
import { Card } from 'antd';
import { metrics, tokens } from '../theme';

export type StatTone = 'ink' | 'success' | 'destructive' | 'warning';

function toneColor(tone: StatTone): string {
  if (tone === 'success') return tokens.successDeep;
  if (tone === 'destructive') return tokens.destructive;
  if (tone === 'warning') return tokens.warning;
  return tokens.ink;
}

export interface StatItem {
  label: string;
  value: ReactNode;
  suffix?: string;
  hint?: ReactNode;
  tone?: StatTone;
}

/**
 * 单个数字：标签 / 数值 / 附注。
 *
 * 只用文字表达，不画进度条——进度条的长度没有刻度，除了制造噪音没有别的用处。
 */
export function Stat({
  label,
  value,
  suffix,
  hint,
  tone = 'ink',
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  hint?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>{label}</div>
      <div
        style={{
          marginTop: metrics.tight,
          fontSize: 30,
          lineHeight: 1.2,
          fontWeight: 600,
          color: toneColor(tone),
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
        }}
      >
        {value}
        {suffix && (
          <span style={{ fontSize: 12, fontWeight: 400, color: tokens.muted, marginLeft: 4 }}>{suffix}</span>
        )}
      </div>
      {hint ? (
        <div style={{ marginTop: metrics.tight, fontSize: 12, lineHeight: 1.6, color: tokens.muted }}>{hint}</div>
      ) : null}
    </div>
  );
}

/**
 * 数字带：一张卡里等分若干段，段与段之间用发丝线分隔。
 *
 * 概览与报表都用它，避免两页各写一套网格之后间距又对不上。
 * 卡片内边距归零，由每个单元格自己撑 24px——第一段的文字才和标题左对齐。
 */
export default function StatBand({ items }: { items: StatItem[] }) {
  return (
    <Card styles={{ body: { padding: 0 } }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((it, i) => (
          <div
            key={it.label}
            style={{
              padding: metrics.cardPadding,
              borderLeft: i === 0 ? 'none' : `1px solid ${tokens.border}`,
            }}
          >
            <Stat {...it} />
          </div>
        ))}
      </div>
    </Card>
  );
}
