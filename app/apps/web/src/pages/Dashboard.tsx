import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Col, Empty, Row, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { api, Overview, TrendPoint } from '../api';
import TrendChart from '../components/TrendChart';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

const REFRESH_MS = 30_000;

/**
 * 数字块：标签 12 / 数值 26 / 附注 12。
 * 三行之间的间距固定为 8，卡片里无论换成哪组数字，垂直节奏都不变。
 */
function Metric({
  label,
  value,
  suffix,
  hint,
  tone = 'ink',
}: {
  label: string;
  value: string | number;
  suffix?: string;
  hint?: React.ReactNode;
  tone?: 'ink' | 'primary' | 'success' | 'destructive';
}) {
  const color =
    tone === 'primary'
      ? tokens.primary
      : tone === 'success'
        ? tokens.successDeep
        : tone === 'destructive'
          ? tokens.destructive
          : tokens.ink;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>{label}</div>
      <div
        style={{
          marginTop: metrics.tight,
          fontSize: 26,
          lineHeight: 1.25,
          fontWeight: 600,
          color,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
        {suffix && (
          <span style={{ fontSize: 13, fontWeight: 400, color: tokens.muted, marginLeft: 4 }}>{suffix}</span>
        )}
      </div>
      {hint && (
        <div style={{ marginTop: 'auto', paddingTop: metrics.snug, fontSize: 12, lineHeight: 1.6, color: tokens.muted }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** 4px 细条，不用 AntD Progress —— 它默认带渐变和圆头，与零阴影的克制风格不符 */
function Bar({ pct, color = tokens.primary }: { pct: number; color?: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ height: 4, background: '#efefec', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${w}%`, height: 4, background: color, borderRadius: 2, transition: 'width .3s' }} />
    </div>
  );
}

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
        padding: `14px ${metrics.cardPadding}px`,
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

export default function Dashboard() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [ov, tr] = await Promise.all([
        api<Overview>('/stats/overview?days=30'),
        api<TrendPoint[]>('/stats/trend?days=30'),
      ]);
      setData(ov);
      setTrend(tr);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api<{ email: string }>('/auth/me')
      .then(setMe)
      .catch(() => undefined);

    // 看板每 30 秒自动刷新；标签页在后台时不刷，避免无谓的数据库压力
    timer.current = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, REFRESH_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
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
  const quotaTone = d.quota.remaining === 0 ? 'destructive' : 'ink';

  return (
    <div className="page">
      <PageHeader
        title="概览"
        desc={`数据截至 ${new Date(d.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}${
          me ? ` · ${me.email}` : ''
        }`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>
            刷新
          </Button>
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

      {/* 首行四张卡等高：卡片撑满栅格高度，附注贴底对齐 */}
      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Metric
              label="今日已发送"
              value={d.today.sent}
              suffix="封"
              hint={`打开 ${d.today.opened} · 点击 ${d.today.clicked}`}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Metric
              label="今日剩余配额"
              value={d.quota.remaining}
              suffix={`/ ${d.quota.totalLimit}`}
              tone={quotaTone}
              hint={`${d.quota.activeAccounts}/${d.quota.accounts} 个账号可用 · ${d.quota.activeChannels} 条通道`}
            />
            <div style={{ marginTop: metrics.snug }}>
              <Bar pct={d.quota.usedPct} color={d.quota.remaining === 0 ? tokens.destructive : tokens.primary} />
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Metric
              label="待发队列"
              value={d.queue.pending}
              suffix="封"
              hint={`${d.totals.activeCampaigns} 个任务进行中${d.queue.overdue > 0 ? ` · ${d.queue.overdue} 封已到期` : ''}`}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card style={{ height: '100%' }}>
            <Metric
              label={`近 ${d.rates.windowDays} 天送达率`}
              value={d.rates.delivered}
              suffix="%"
              tone={d.rates.delivered >= 95 ? 'success' : d.rates.delivered >= 85 ? 'ink' : 'destructive'}
              hint={`退信 ${d.rates.bounced}% · 打开 ${d.rates.opened}%`}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={8}>
          <Section title="账号配额" desc="按真实账号聚合，同一账号的通道共享额度" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
              {d.accounts.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有发件账号"
                  style={{ padding: '56px 24px', margin: 0 }}
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
                      padding: `14px ${metrics.cardPadding}px`,
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: metrics.tight }}>
                      <span
                        style={{
                          fontSize: 13,
                          color: tokens.ink,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.name}
                        {c.channelCount > 1 && (
                          <Tag bordered={false} color="gold" style={{ marginInlineStart: 6, fontSize: 10 }}>
                            共享 {c.channelCount} 条
                          </Tag>
                        )}
                      </span>
                      <span style={{ fontSize: 12, color: tokens.muted, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                        {c.used}/{c.limit}
                      </span>
                    </div>
                    <div style={{ marginTop: metrics.tight }}>
                      <Bar
                        pct={c.usedPct}
                        color={
                          c.status !== 'active'
                            ? tokens.borderStrong
                            : c.remaining === 0
                              ? tokens.destructive
                              : tokens.primary
                        }
                      />
                    </div>
                    {c.status !== 'active' && (
                      <div style={{ fontSize: 11, color: tokens.destructive, marginTop: 4 }}>
                        {c.status === 'error' ? '已自动停用' : '已暂停'}
                        {c.lastError ? ` · ${c.lastError.slice(0, 40)}` : ''}
                      </div>
                    )}
                  </div>
                ))
              )}
            </Card>
          </Section>
        </Col>

        <Col span={8}>
          <Section title="联系人" desc="抑制名单不会再收到任何邮件" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              <Row gutter={metrics.gridGutter}>
                <Col span={12}>
                  <Metric label="总联系人" value={d.totals.contacts} hint={`今日新增 ${d.today.newContacts}`} />
                </Col>
                <Col span={12}>
                  <Metric label="可投递" value={d.totals.reachable} tone="success" hint={`抑制 ${d.totals.suppressed}`} />
                </Col>
              </Row>
              <div style={{ marginTop: metrics.gridGutter }}>
                <Bar pct={(d.totals.reachable / Math.max(d.totals.contacts, 1)) * 100} color={tokens.success} />
                <div style={{ fontSize: 12, color: tokens.muted, marginTop: metrics.tight, lineHeight: 1.6 }}>
                  可投递占比 {Math.round((d.totals.reachable / Math.max(d.totals.contacts, 1)) * 1000) / 10}%
                </div>
              </div>
            </Card>
          </Section>
        </Col>

        <Col span={8}>
          <Section title="近 30 天效果" desc={`统计基数 ${d.rates.settled} 封已出结果`} style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              <Row gutter={metrics.gridGutter}>
                <Col span={8}>
                  <Metric label="打开率" value={d.rates.opened} suffix="%" />
                </Col>
                <Col span={8}>
                  <Metric label="点击率" value={d.rates.clicked} suffix="%" />
                </Col>
                <Col span={8}>
                  <Metric
                    label="退信率"
                    value={d.rates.bounced}
                    suffix="%"
                    tone={d.rates.bounced >= 5 ? 'destructive' : 'ink'}
                  />
                </Col>
              </Row>
              <div style={{ marginTop: metrics.gridGutter, fontSize: 12, color: tokens.muted, lineHeight: 1.6 }}>
                按已出结果的 {d.rates.windowDays} 天数据计算，排队中的不计入分母。
              </div>
            </Card>
          </Section>
        </Col>
      </Row>

      <Section title="发送趋势（近 30 天）" desc="柱为每日发送量，折线为打开率">
        <Card styles={{ body: { paddingTop: metrics.tight } }}>
          <TrendChart data={trend} height={280} />
        </Card>
      </Section>
    </div>
  );
}
