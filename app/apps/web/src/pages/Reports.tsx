import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, Segmented, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api, ChannelStat, TrendPoint } from '../api';
import TrendChart from '../components/TrendChart';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

const RANGES = [
  { label: '7 天', value: 7 },
  { label: '14 天', value: 14 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
];

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队中',
  running: '发送中',
  paused: '已暂停',
  done: '已完成',
  canceled: '已取消',
  active: '正常',
  error: '已停用',
};

/** SMTP 错误码翻成人话。认不出来的原样展示，不做猜测。 */
const ERROR_LABEL: Record<string, string> = {
  EAUTH: '认证失败',
  ETIMEDOUT: '连接超时',
  ESOCKET: '连接中断 / TLS 失败',
  EDNS: '域名解析失败',
  EENVELOPE: '收件人被拒',
  EMESSAGE: '内容被拒',
  ECONNECTION: '无法建立连接',
  EMAXCONNECTIONS: '连接数超限',
  SUPPRESSED: '地址不存在',
  UNKNOWN: '未知原因',
};

function statusTag(s: string) {
  const map: Record<string, string> = {
    done: 'green',
    running: 'blue',
    paused: 'orange',
    canceled: 'default',
    draft: 'default',
    queued: 'gold',
    active: 'green',
    error: 'red',
  };
  return (
    <Tag color={map[s] ?? 'default'} bordered={false} style={{ marginInlineEnd: 0 }}>
      {STATUS_LABEL[s] ?? s}
    </Tag>
  );
}

/**
 * 比率单元格。
 * base=0 时必须显示「—」而不是「0%」——
 * 一个从没发过信的账号，成功率是"没有数据"，不是"零分"。
 */
function RateCell({ v, base, good = 90, ok = 70 }: { v: number; base: number; good?: number; ok?: number }) {
  if (!base) return <span style={{ color: tokens.muted }}>—</span>;
  const color = v >= good ? tokens.successDeep : v >= ok ? tokens.foreground : tokens.destructive;
  return <span style={{ fontVariantNumeric: 'tabular-nums', color }}>{v}%</span>;
}

export default function Reports() {
  const [days, setDays] = useState(30);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [failures, setFailures] = useState<{ code: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    try {
      const [tr, ch, fa] = await Promise.all([
        api<TrendPoint[]>(`/stats/trend?days=${range}`),
        api<ChannelStat[]>(`/stats/channels?days=${range}`),
        api<{ code: string; count: number }[]>(`/stats/failures?days=${range}`),
      ]);
      setTrend(tr);
      setChannels(ch);
      setFailures(fa);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const channelCols: ColumnsType<ChannelStat> = [
    {
      title: '账号',
      dataIndex: 'fromEmail',
      render: (_, r) => (
        <div>
          <div style={{ color: tokens.ink }}>{r.fromEmail}</div>
          <div style={{ fontSize: 12, color: tokens.muted }}>{r.host}</div>
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => statusTag(s) },
    {
      title: '今日配额',
      width: 150,
      render: (_, r) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: r.remaining === 0 ? tokens.destructive : tokens.foreground }}>
          {r.usedToday} / {r.dailyLimit}
        </span>
      ),
    },
    {
      title: '窗口内发送',
      dataIndex: 'sent',
      width: 116,
      align: 'right',
      render: (v: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>,
    },
    {
      title: '失败',
      dataIndex: 'failed',
      width: 88,
      align: 'right',
      render: (v: number) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: v > 0 ? tokens.destructive : tokens.muted }}>{v}</span>
      ),
    },
    {
      title: '成功率',
      dataIndex: 'successRate',
      width: 96,
      align: 'right',
      render: (v: number, r) => <RateCell v={v} base={r.sent + r.failed} good={95} ok={80} />,
    },
  ];

  const failureTotal = failures.reduce((s, f) => s + f.count, 0);

  return (
    <div className="page">
      <PageHeader
        title="统计报表"
        extra={<Segmented options={RANGES} value={days} onChange={(v) => setDays(v as number)} />}
      />

      {error && (
        <div
          style={{
            padding: `14px ${metrics.cardPadding}px`,
            border: `1px solid ${tokens.destructiveSoft}`,
            background: tokens.destructiveSoft,
            borderRadius: metrics.cardRadius,
            color: tokens.destructiveDeep,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <Section title={`发送趋势（近 ${days} 天）`}>
        <Card styles={{ body: { paddingTop: metrics.tight } }}>
          {loading && trend.length === 0 ? (
            <div style={{ padding: 64, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : (
            <TrendChart data={trend} height={260} />
          )}
        </Card>
      </Section>

      <Section title="账号表现">
        <Card className="card-table">
          <Table
            rowKey="id"
            pagination={false}
            columns={channelCols}
            dataSource={channels}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有发件账号" /> }}
          />
        </Card>
      </Section>

    <Section title="失败原因分布" desc={`近 ${days} 天共 ${failureTotal} 封失败`}>
      <Card>
        {failures.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`近 ${days} 天没有失败记录`}
            style={{ padding: '40px 0', margin: 0 }}
          />
        ) : (
          <div>
            {failures.map((f, i) => {
              const pct = (f.count / Math.max(failureTotal, 1)) * 100;
              return (
                <div key={f.code} style={{ marginTop: i === 0 ? 0 : metrics.gridGutter }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      marginBottom: 6,
                      gap: metrics.snug,
                    }}
                  >
                    <span style={{ color: tokens.foreground }}>{ERROR_LABEL[f.code] ?? f.code}</span>
                    <span style={{ color: tokens.muted, fontVariantNumeric: 'tabular-nums' }}>{f.count}</span>
                  </div>
                  <div style={{ height: 4, background: '#efefec', borderRadius: 2 }}>
                    <div
                      style={{
                        width: `${Math.max(pct, 2)}%`,
                        height: 4,
                        background: tokens.destructive,
                        borderRadius: 2,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </Section>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${sec % 60 ? `${sec % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}
