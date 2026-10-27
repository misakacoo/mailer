import { useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../theme';
import type { TrendPoint } from '../api';

const COLORS = {
  sent: '#a96510',
  opened: '#cf9a54',
  clicked: '#e3c49b',
  failed: '#bd2c32',
};

const SERIES: { key: keyof Omit<TrendPoint, 'day'>; label: string }[] = [
  { key: 'sent', label: '已发送' },
  { key: 'opened', label: '打开' },
  { key: 'clicked', label: '点击' },
  { key: 'failed', label: '失败' },
];

/** 把最大值抬到"好看"的刻度：10 / 20 / 50 / 100 / 200 …，否则柱顶会顶到边框 */
function niceCeil(v: number): number {
  if (v <= 0) return 10;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= base * m) return base * m;
  }
  return base * 10;
}

function fmt(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 手写 SVG 柱状图，不引入图表库。
 * 14 天的数据量不值得为此加 1MB 依赖，而且自己画才能保证
 * 零阴影、发丝网格线、琥珀单色系这些令牌不被库的默认样式覆盖。
 */
export default function TrendChart({ data, height = 240 }: { data: TrendPoint[]; height?: number }) {
  /**
   * 宽度跟着容器走。
   * 原来写死 760px，卡片一宽图表就居中留出大片空白，
   * 而用 viewBox 拉伸又会把文字和柱子一起拉变形——所以按真实像素宽重算坐标。
   */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setW(Math.max(320, Math.round(el.clientWidth)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const padL = 42;
  const padR = 8;
  const padT = 14;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { max, slotW } = useMemo(() => {
    let peak = 0;
    for (const d of data) {
      peak = Math.max(peak, d.sent, d.opened, d.clicked, d.failed);
    }
    return { max: niceCeil(peak), slotW: data.length > 0 ? plotW / data.length : plotW };
  }, [data, plotW]);

  if (data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: tokens.muted, fontSize: 13 }}>
        暂无数据
      </div>
    );
  }

  /**
   * 跨度超过一个月时，一天只有七八像素，四根柱会细到看不出区别。
   * 这时只保留两条最能说明问题的：发了多少、失败多少——
   * 长周期看的是量与异常，不是单日打开率。
   */
  const series = data.length > 31 ? SERIES.filter((s) => s.key === 'sent' || s.key === 'failed') : SERIES;

  const barGroupW = slotW * 0.86;
  const barW = Math.max(2, (barGroupW - (series.length - 1)) / series.length);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // 日期标签密度：超过 14 天就隔一个显示，避免挤成一团
  const labelStep = data.length > 20 ? 5 : data.length > 10 ? 2 : 1;

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="发送趋势">
        {/* 网格线与 Y 轴刻度 */}
        {ticks.map((t) => {
          const y = padT + plotH * (1 - t);
          return (
            <g key={t}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke={t === 0 ? tokens.borderStrong : tokens.border}
                strokeWidth={1}
              />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill={tokens.muted}>
                {fmt(Math.round(max * t))}
              </text>
            </g>
          );
        })}

        {/* 柱子 */}
        {data.map((d, i) => {
          const groupX = padL + slotW * i + (slotW - barGroupW) / 2;
          return (
            <g key={d.day}>
              {series.map((s, si) => {
                const v = d[s.key];
                const h = max > 0 ? (v / max) * plotH : 0;
                const x = groupX + si * (barW + 1);
                const y = padT + plotH - h;
                return (
                  <g key={s.key}>
                    <rect
                      x={x}
                      y={h > 0 ? y : padT + plotH}
                      width={barW}
                      height={Math.max(h, 0)}
                      fill={COLORS[s.key]}
                      rx={1.5}
                    >
                      <title>{`${d.day} ${s.label} ${v}`}</title>
                    </rect>
                  </g>
                );
              })}
              {i % labelStep === 0 && (
                <text
                  x={padL + slotW * i + slotW / 2}
                  y={H - 10}
                  textAnchor="middle"
                  fontSize={10}
                  fill={tokens.muted}
                >
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'flex', gap: 18, paddingLeft: padL, marginTop: 4, flexWrap: 'wrap' }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.muted }}>
            <span style={{ width: 9, height: 9, background: COLORS[s.key], borderRadius: 2 }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
