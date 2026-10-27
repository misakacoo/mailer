import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Col, Empty, Row, Spin, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { api, Overview, TrendPoint } from '../api';
import TrendChart from '../components/TrendChart';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

const REFRESH_MS = 30_000;

/**
 * 数字块：标签 / 数值 / 附注三行。
 * 只用文字与数字表达进度，不画进度条——「还剩几封」这个信息本身就有数字，
 * 再叠一根长度任意、刻度不明的条，除了制造噪音没有别的用处。
 */
function Stat({
  label,
  value,
  suffix,
  hint,
  tone = 'ink',
  size = 'md',
  align = 'left',
}: {
  label: string;
  value: string | number;
  suffix?: string;
  hint?: React.ReactNode;
  tone?: 'ink' | 'success' | 'destructive' | 'warning';
  size?: 'md' | 'lg';
  align?: 'left' | 'right';
}) {
  const color =
    tone === 'success'
      ? tokens.successDeep
      : tone === 'destructive'
        ? tokens.destructive
        : tone === 'warning'
          ? tokens.warning
          : tokens.ink;
  return (
    <div style={{ textAlign: align, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>{label}</div>
      <div
        style={{
          marginTop: metrics.tight,
          fontSize: size === 'lg' ? 32 : 22,
          lineHeight: 1.2,
          fontWeight: 600,
          color,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.015em',
        }}
      >
        {value}
        {suffix && (
          <span style={{ fontSize: 12, fontWeight: 400, color: tokens.muted, marginLeft: 4 }}>{suffix}</span>
        )}
      </div>
      {hint && (
        <div style={{ marginTop: metrics.tight, fontSize: 12, lineHeight: 1.6, color: tokens.muted }}>{hint}</div>
      )}
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
    <div style={{ display: 'flex', gap: metrics.snug, padding: `14px ${metrics.cardPadding}px`, alignItems: 'flex-start' }}>
      <div style={{ width: 3, alignSelf: 'stretch', background: color, borderRadius: 2, flex: '0 0 3px' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: tokens.ink, lineHeight: 1.6 }}>{message}</div>
        {hint && <div style={{ fontSize: 12, color: tokens.muted, marginTop: 4, lineHeight: 1.6 }}>{hint}</div>}
      </div>
      {tag}
    </div>
  );
}

/** 数据带里的一段：左侧标签+数值，右侧同组第二指标 */
function BandCell({
  label,
  value,
  suffix,
  hint,
  tone,
  last,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  hint?: React.ReactNode;
  tone?: 'ink' | 'success' | 'destructive' | 'warning';
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: `${metrics.cardPadding}px 0`,
        paddingLeft: last ? metrics.cardPadding : 0,
        paddingRight: metrics.cardPadding,
        borderLeft: last ? `1px solid ${tokens.border}` : 'none',
      }}
    >
      <Stat label={label} value={value} suffix={suffix} hint={hint} tone={tone} size="lg" />
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
  const quotaLeft = d.quota.remaining;
  const quotaTone = quotaLeft === 0 ? 'destructive' : 'ink';
  const deliverTone = d.rates.delivered >= 95 ? 'success' : d.rates.delivered >= 85 ? 'ink' : 'destructive';

  return (
    <div className="page">
      <PageHeader
        title="概览"
        desc={`数据截至 ${new Date(d.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}${
          me ? ` · ${me.email}` : ''
        }`}
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

      {/* 今日数据带：四段等宽，一条卡承载，不再拆成四张卡 */}
      <Card styles={{ body: { padding: 0 } }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div style={{ padding: `${metrics.cardPadding}px`, paddingRight: metrics.cardPadding }}>
            <Stat
              label="今日已发送"
              value={d.today.sent}
              suffix="封"
              size="lg"
              hint={`打开 ${d.today.opened} · 点击 ${d.today.clicked}`}
            />
          </div>
          <BandCell
            label="今日剩余配额"
            value={quotaLeft}
            suffix={`/ ${d.quota.totalLimit}`}
            tone={quotaTone}
            hint={`${d.quota.active} 个发件邮箱可用`}
          />
          <BandCell
            label="待发队列"
            value={d.queue.pending}
            suffix="封"
            tone={d.queue.overdue > 0 ? 'warning' : 'ink'}
            hint={
              d.queue.overdue > 0
                ? `${d.queue.overdue} 封已到期未发出`
                : `${d.totals.activeCampaigns} 个任务进行中`
            }
          />
          <BandCell
            label={`近 ${d.rates.windowDays} 天送达率`}
            value={d.rates.delivered}
            suffix="%"
            tone={deliverTone}
            hint={`退信 ${d.rates.bounced}% · 打开 ${d.rates.opened}%`}
            last
          />
        </div>
      </Card>

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={14}>
          <Section
            title="发件邮箱"
            desc="每个邮箱独立配置与计数；停用或异常的不参与发送"
            style={{ height: '100%' }}
          >
            <Card style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
              {d.accounts.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有发件邮箱"
                  style={{ padding: '48px 24px', margin: 0 }}
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
                      gap: metrics.gridGutter,
                      padding: `12px ${metrics.cardPadding}px`,
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
                        <span style={{ fontSize: 11, color: tokens.muted, marginLeft: 8 }}>
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
                        color: c.remaining === 0 ? tokens.destructive : tokens.ink,
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
                    padding: `10px ${metrics.cardPadding}px`,
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

        <Col span={10}>
          <Section title="运行状况" desc="队列与联系人的当前状态" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              <div style={{ fontSize: 12, color: tokens.muted, marginBottom: metrics.snug }}>队列</div>
              <Row gutter={metrics.gridGutter}>
                <Col span={8}>
                  <Stat label="待发" value={d.queue.pending} />
                </Col>
                <Col span={8}>
                  <Stat
                    label="已到期"
                    value={d.queue.overdue}
                    tone={d.queue.overdue > 0 ? 'warning' : 'ink'}
                  />
                </Col>
                <Col span={8}>
                  <Stat label="失败" value={d.queue.failed} tone={d.queue.failed > 0 ? 'destructive' : 'ink'} />
                </Col>
              </Row>

              <div
                style={{
                  marginTop: metrics.gridGutter,
                  paddingTop: metrics.gridGutter,
                  borderTop: `1px solid ${tokens.border}`,
                  fontSize: 12,
                  color: tokens.muted,
                  marginBottom: metrics.snug,
                }}
              >
                联系人
              </div>
              <Row gutter={metrics.gridGutter}>
                <Col span={8}>
                  <Stat label="总数" value={d.totals.contacts} />
                </Col>
                <Col span={8}>
                  <Stat
                    label="可投递"
                    value={d.totals.reachable}
                    tone="success"
                    hint={`今日新增 ${d.today.newContacts}`}
                  />
                </Col>
                <Col span={8}>
                  <Stat label="抑制" value={d.totals.suppressed} hint="不再发送" />
                </Col>
              </Row>

              <div
                style={{
                  marginTop: metrics.gridGutter,
                  paddingTop: metrics.gridGutter,
                  borderTop: `1px solid ${tokens.border}`,
                  fontSize: 12,
                  color: tokens.muted,
                  marginBottom: metrics.snug,
                }}
              >
                任务
              </div>
              <Row gutter={metrics.gridGutter}>
                <Col span={8}>
                  <Stat label="总数" value={d.totals.campaigns} />
                </Col>
                <Col span={8}>
                  <Stat label="进行中" value={d.totals.activeCampaigns} />
                </Col>
                <Col span={8}>
                  <Stat label="已完成" value={d.totals.doneCampaigns} />
                </Col>
              </Row>
            </Card>
          </Section>
        </Col>
      </Row>

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={9}>
          <Section
            title={`近 ${d.rates.windowDays} 天效果`}
            desc={`按 ${d.rates.settled} 封已出结果的邮件计算，排队中的不计入分母`}
            style={{ height: '100%' }}
          >
            <Card style={{ height: '100%' }}>
              <Row gutter={[metrics.gridGutter, metrics.gridGutter]}>
                <Col span={12}>
                  <Stat label="送达率" value={d.rates.delivered} suffix="%" tone={deliverTone} />
                </Col>
                <Col span={12}>
                  <Stat label="退信率" value={d.rates.bounced} suffix="%" tone={d.rates.bounced >= 5 ? 'destructive' : 'ink'} />
                </Col>
                <Col span={12}>
                  <Stat label="打开率" value={d.rates.opened} suffix="%" />
                </Col>
                <Col span={12}>
                  <Stat label="点击率" value={d.rates.clicked} suffix="%" />
                </Col>
              </Row>
            </Card>
          </Section>
        </Col>

        <Col span={15}>
          <Section title="发送趋势（近 30 天）" desc="柱为每日发送量，折线为打开率" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }} styles={{ body: { paddingTop: metrics.tight } }}>
              <TrendChart data={trend} height={230} />
            </Card>
          </Section>
        </Col>
      </Row>
    </div>
  );
}
