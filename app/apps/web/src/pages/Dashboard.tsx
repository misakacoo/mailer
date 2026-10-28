import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Empty, Row, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { api, Overview } from '../api';
import StatBand from '../components/StatBand';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

const REFRESH_MS = 30_000;

function AlertRow({ level, message, hint }: { level: 'error' | 'warn' | 'info'; message: string; hint?: string }) {
  const color = level === 'error' ? tokens.destructive : level === 'warn' ? tokens.warning : tokens.muted;
  const tag =
    level === 'error' ? (
      <Tag color="red" bordered={false} style={{ marginInlineEnd: 0 }}>严重</Tag>
    ) : level === 'warn' ? (
      <Tag color="orange" bordered={false} style={{ marginInlineEnd: 0 }}>注意</Tag>
    ) : (
      <Tag bordered={false} style={{ marginInlineEnd: 0 }}>提示</Tag>
    );
  return (
    <div
      style={{
        display: 'flex',
        gap: metrics.snug,
        padding: `${metrics.snug}px ${metrics.cardPadding}px`,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ width: 3, alignSelf: 'stretch', background: color, borderRadius: 2, flex: '0 0 3px' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: tokens.ink, lineHeight: 1.6 }}>{message}</div>
        {hint && <div style={{ fontSize: 12, color: tokens.muted, marginTop: 4, lineHeight: 1.6 }}>{hint}</div>}
      </div>
      {tag}
    </div>
  );
}

/** 小号数字：用在右栏的 2×3 网格里，比数字带低一档，避免和顶部抢视线 */
function MiniStat({ label, value, tone = 'ink' }: { label: string; value: number; tone?: 'ink' | 'destructive' }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>{label}</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 20,
          lineHeight: 1.3,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: tone === 'destructive' ? tokens.destructive : tokens.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const ov = await api<Overview>('/stats/overview');
      setData(ov);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();

    // 看板每 30 秒自动刷新；标签页在后台时不刷，避免无谓的数据库压力
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading && !data) {
    return (
      <div style={{ padding: 96, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <Empty description={`加载失败：${error}`}>
          <Button onClick={() => load()}>重试</Button>
        </Empty>
      </Card>
    );
  }

  const d = data!;
  const quotaLeft = d.quota.remaining;

  return (
    <div className="page">
      <PageHeader
        title="概览"
        desc={`数据截至 ${new Date(d.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading} />
        }
      />

      {d.alerts.length > 0 && (
        <Section title={`需要注意（${d.alerts.length}）`}>
          <Card styles={{ body: { padding: 0 } }}>
            {d.alerts.map((a, i) => (
              <div key={a.code + a.message} style={{ borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}` }}>
                <AlertRow level={a.level} message={a.message} hint={a.hint} />
              </div>
            ))}
          </Card>
        </Section>
      )}

      <Section title="今日">
        <StatBand
          items={[
            {
              label: '已发送',
              value: d.today.sent,
              suffix: '封',
              hint: `打开 ${d.today.opened} · 点击 ${d.today.clicked}`,
            },
            {
              label: '失败',
              value: d.today.failed,
              suffix: '封',
              tone: d.today.failed > 0 ? 'destructive' : 'ink',
              hint: d.today.failed > 0 ? '见「投递明细」中的错误码' : '没有失败',
            },
            {
              label: '待发队列',
              value: d.queue.pending,
              suffix: '封',
              tone: d.queue.overdue > 0 ? 'warning' : 'ink',
              hint:
                d.queue.overdue > 0
                  ? `${d.queue.overdue} 封已到期未发出`
                  : `${d.totals.activeCampaigns} 个任务进行中`,
            },
            {
              label: '剩余配额',
              value: quotaLeft,
              suffix: `/ ${d.quota.totalLimit}`,
              tone: quotaLeft === 0 ? 'destructive' : 'ink',
              hint: `${d.quota.active} 个发件邮箱可用`,
            },
          ]}
        />
      </Section>

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={15}>
          <Section title="发件邮箱" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
              {d.accounts.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有发件邮箱"
                  style={{ padding: `${metrics.sectionGap}px ${metrics.cardPadding}px`, margin: 0 }}
                >
                  <Link to="/channels">
                    <Button type="primary" size="small">去添加</Button>
                  </Link>
                </Empty>
              ) : (
                d.accounts.map((c, i) => (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: metrics.snug,
                      padding: `${metrics.snug}px ${metrics.cardPadding}px`,
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        flex: '0 0 6px',
                        background:
                          c.status === 'active'
                            ? tokens.success
                            : c.status === 'error'
                              ? tokens.destructive
                              : tokens.borderStrong,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        color: tokens.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.fromEmail}
                      {c.status !== 'active' && (
                        <span style={{ fontSize: 12, color: tokens.muted, marginLeft: metrics.tight }}>
                          {c.status === 'error' ? '异常' : '已停用'}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: tokens.muted,
                        fontVariantNumeric: 'tabular-nums',
                        flex: '0 0 auto',
                      }}
                    >
                      今日 {c.used} / {c.limit}
                    </span>
                    <span
                      style={{
                        width: 72,
                        textAlign: 'right',
                        fontSize: 12,
                        fontVariantNumeric: 'tabular-nums',
                        color: c.remaining === 0 ? tokens.destructive : tokens.foreground,
                        flex: '0 0 auto',
                      }}
                    >
                      剩 {c.remaining}
                    </span>
                  </div>
                ))
              )}
              {d.accounts.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: metrics.snug,
                    padding: `${metrics.snug}px ${metrics.cardPadding}px`,
                    borderTop: `1px solid ${tokens.border}`,
                    fontSize: 12,
                    color: tokens.muted,
                  }}
                >
                  <span>
                    共 {d.accounts.length} 个，{d.quota.active} 个可用
                  </span>
                  <Link to="/channels" style={{ fontSize: 12 }}>
                    管理发件邮箱 →
                  </Link>
                </div>
              )}
            </Card>
          </Section>
        </Col>

        <Col span={9}>
          <Section title="联系人与任务" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                {[
                  { label: '联系人', value: d.totals.contacts },
                  { label: '可投递', value: d.totals.reachable },
                  {
                    label: '地址不存在',
                    value: d.totals.undeliverable,
                    tone: d.totals.undeliverable > 0 ? ('destructive' as const) : ('ink' as const),
                  },
                  { label: '任务', value: d.totals.campaigns },
                  { label: '进行中', value: d.totals.activeCampaigns },
                  { label: '已完成', value: d.totals.doneCampaigns },
                ].map((s, i) => (
                  <div
                    key={s.label}
                    style={{
                      padding: metrics.cardPaddingCompact,
                      borderLeft: i % 3 === 0 ? 'none' : `1px solid ${tokens.border}`,
                      borderTop: i < 3 ? 'none' : `1px solid ${tokens.border}`,
                    }}
                  >
                    <MiniStat label={s.label} value={s.value} tone={s.tone} />
                  </div>
                ))}
              </div>
            </Card>
          </Section>
        </Col>
      </Row>
    </div>
  );
}
