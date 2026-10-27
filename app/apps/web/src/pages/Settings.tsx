import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Radio,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { api, AuditLog, OpsCheck } from '../api';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

interface SystemInfo {
  day: string;
  node: string;
  platform: string;
  uptimeSec: number;
  rssMb: number;
  appUrl: string;
  backupDir: string | null;
  tlsCertPath: string | null;
  quotaToday: { day: string; limit: number; used: number; remaining: number };
}

const TABLE_LABEL: Record<string, string> = {
  auth: '登录',
  channels: '发件账号',
  contacts: '联系人',
  lists: '分组',
  templates: '模板',
  campaigns: '群发任务',
  ops: '系统',
};

const VERB_LABEL: Record<string, string> = {
  create: '新建',
  update: '修改',
  delete: '删除',
  start: '启动',
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  schedule: '排期',
  unschedule: '取消排期',
  login: '登录',
  logout: '退出',
  duplicate: '复制',
  test: '测试',
  'test-connection': '测试连接',
  'test-send': '发送测试信',
  'mark-backup': '标记备份',
  preview: '预览',
  commit: '导入',
  blacklist: '拉黑',
};

function describeAction(action: string): { text: string; failed: boolean } {
  const parts = action.split('.');
  const table = TABLE_LABEL[parts[0]] ?? parts[0];
  const failed = parts.includes('failed');
  const verbKey = parts.find((p) => p !== 'failed' && p !== parts[0]) ?? '';
  const verb = VERB_LABEL[verbKey] ?? verbKey;
  return { text: `${table} · ${verb}`, failed };
}

function CheckIcon({ status }: { status: OpsCheck['status'] }) {
  if (status === 'ok') return <CheckCircleFilled style={{ color: tokens.success, fontSize: 16 }} />;
  if (status === 'warn') return <ExclamationCircleFilled style={{ color: tokens.warning, fontSize: 16 }} />;
  if (status === 'error') return <CloseCircleFilled style={{ color: tokens.destructive, fontSize: 16 }} />;
  return <MinusCircleOutlined style={{ color: tokens.muted, fontSize: 16 }} />;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分钟`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export default function Settings() {
  const { message, modal } = AntApp.useApp();
  const [checks, setChecks] = useState<OpsCheck[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [loadingCheck, setLoadingCheck] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearScope, setClearScope] = useState<'all' | '90'>('90');
  const [clearing, setClearing] = useState(false);

  const runCheck = useCallback(async () => {
    setLoadingCheck(true);
    try {
      const [r, i] = await Promise.all([
        api<{ checks: OpsCheck[]; ok: boolean; generatedAt: string }>('/ops/self-check'),
        api<SystemInfo>('/ops/system'),
      ]);
      setChecks(Array.isArray(r.checks) ? r.checks : []);
      setCheckedAt(r.generatedAt);
      setInfo(i);
    } catch {
      // 自检本身失败时给出可读的占位，而不是空白页面
      setChecks([
        {
          key: 'api',
          label: '接口',
          status: 'error',
          detail: '无法获取自检结果，请确认服务是否正常',
        },
      ]);
    } finally {
      setLoadingCheck(false);
    }
  }, []);

  const loadLogs = useCallback(async (p: number, size: number, kw: string) => {
    setLoadingLogs(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(size) });
      if (kw.trim()) qs.set('action', kw.trim());
      const r = await api<{ total: number; items: AuditLog[] }>(`/ops/audit-logs?${qs}`);
      setLogs(Array.isArray(r.items) ? r.items : []);
      setLogTotal(Number(r.total) || 0);
    } catch {
      setLogs([]);
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  const clearLogs = async () => {
    setClearing(true);
    try {
      const qs = clearScope === 'all' ? '' : '?beforeDays=90';
      const r = await api<{ deleted: number }>(`/ops/audit-logs${qs}`, { method: 'DELETE' });
      message.success(r.deleted > 0 ? `已清除 ${r.deleted} 条日志` : '没有符合条件的日志');
      setClearOpen(false);
      setPage(1);
      await loadLogs(1, pageSize, keyword);
    } catch (e: any) {
      message.error(e?.message ?? '清除失败');
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  useEffect(() => {
    void loadLogs(page, pageSize, keyword);
    // keyword 变化时由用户点搜索触发，不在这里自动查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const logCols: ColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: string) => (
        <span className="mono" style={{ fontSize: 12 }}>
          {new Date(v).toLocaleString('zh-CN', { hour12: false })}
        </span>
      ),
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 150,
      render: (v: string) => {
        const { text, failed } = describeAction(v);
        return (
          <span style={{ color: failed ? tokens.destructive : tokens.foreground, fontSize: 13 }}>
            {text}
            {failed && ' 失败'}
          </span>
        );
      },
    },
    {
      title: '对象',
      dataIndex: 'target',
      width: 140,
      render: (v: string | null) => (v ? <span className="mono" style={{ fontSize: 12 }}>{v}</span> : <span style={{ color: tokens.muted }}>—</span>),
    },
    {
      title: '状态码',
      width: 80,
      render: (_, r) => {
        const status = Number((r.detail as any)?.status ?? 0);
        const bad = status >= 400;
        return status ? (
          <Tag color={bad ? 'red' : 'default'} bordered={false} style={{ marginInlineEnd: 0 }}>
            {status}
          </Tag>
        ) : (
          <span style={{ color: tokens.muted }}>—</span>
        );
      },
    },
    {
      title: '来源 IP',
      dataIndex: 'ip',
      width: 130,
      render: (v: string | null) => <span className="mono" style={{ fontSize: 12 }}>{v ?? '—'}</span>,
    },
    {
      title: '耗时',
      width: 80,
      align: 'right',
      render: (_, r) => {
        const ms = Number((r.detail as any)?.elapsedMs ?? 0);
        return <span style={{ fontSize: 12, color: tokens.muted }}>{ms ? `${ms}ms` : '—'}</span>;
      },
    },
  ];

  const problemCount = checks.filter((c) => c.status === 'error').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return (
    <div className="page">
      <PageHeader
        title="系统运维"
        desc={`${
          problemCount > 0
            ? `${problemCount} 项异常需要处理`
            : warnCount > 0
              ? `${warnCount} 项需要注意`
              : '全部检查通过'
        }${checkedAt ? ` · 检查于 ${new Date(checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => runCheck()} loading={loadingCheck}>
            重新检查
          </Button>
        }
      />

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={14}>
          <Section title="系统自检" desc="数据库、发送进程、磁盘、证书、备份与队列" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
              {loadingCheck && checks.length === 0 ? (
                <div style={{ padding: 56, textAlign: 'center' }}>
                  <Spin />
                </div>
              ) : (
                checks.map((c, i) => (
                  <div
                    key={c.key}
                    style={{
                      display: 'flex',
                      gap: metrics.snug,
                      padding: `14px ${metrics.cardPadding}px`,
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                      alignItems: 'flex-start',
                    }}
                  >
                    <div style={{ paddingTop: 1 }}>
                      <CheckIcon status={c.status} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: tokens.ink, lineHeight: 1.5 }}>{c.label}</div>
                      <div style={{ fontSize: 12, color: tokens.muted, marginTop: 4, lineHeight: 1.6 }}>
                        {c.detail}
                      </div>
                    </div>
                    {c.value && (
                      <span className="mono" style={{ fontSize: 12, color: tokens.muted, flex: '0 0 auto' }}>
                        {c.value}
                      </span>
                    )}
                  </div>
                ))
              )}
            </Card>
          </Section>
        </Col>

        <Col span={10}>
          <Section title="运行环境" desc="当前进程与站点配置" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              {info ? (
                <Descriptions column={1} size="small" colon={false} labelStyle={{ color: tokens.muted, width: 96 }}>
                  <Descriptions.Item label="站点">
                    <span className="mono" style={{ fontSize: 12 }}>{info.appUrl}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="业务日">{info.day}</Descriptions.Item>
                  <Descriptions.Item label="今日配额">
                    {info.quotaToday.used} / {info.quotaToday.limit}（剩 {info.quotaToday.remaining}）
                  </Descriptions.Item>
                  <Descriptions.Item label="Node">{info.node}</Descriptions.Item>
                  <Descriptions.Item label="平台">{info.platform}</Descriptions.Item>
                  <Descriptions.Item label="API 运行">{formatUptime(info.uptimeSec)}</Descriptions.Item>
                  <Descriptions.Item label="内存占用">{info.rssMb} MB</Descriptions.Item>
                  <Descriptions.Item label="备份目录">
                    <span className="mono" style={{ fontSize: 12 }}>{info.backupDir ?? '未配置'}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label="证书路径">
                    <span className="mono" style={{ fontSize: 12 }}>{info.tlsCertPath ?? '未配置'}</span>
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中" style={{ padding: '40px 0', margin: 0 }} />
              )}
            </Card>
          </Section>
        </Col>
      </Row>

      <Section
        title="操作日志"
        desc="记录每一次写操作，用于回溯「谁在什么时候改了什么」"
        extra={
          <>
            <Input.Search
              placeholder="按动作筛选，如 campaigns、login"
              allowClear
              style={{ width: 260 }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={(v) => {
                setPage(1);
                void loadLogs(1, pageSize, v);
              }}
            />
            <Button onClick={() => setClearOpen(true)}>清除日志</Button>
          </>
        }
      >
        <Card className="card-table">
          <Table
            rowKey="id"
            columns={logCols}
            dataSource={logs}
            loading={loadingLogs}
            pagination={{
              current: page,
              pageSize,
              total: logTotal,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100],
              showTotal: (t2) => `共 ${t2} 条`,
              onChange: (p2, s) => {
                setPage(p2);
                setPageSize(s);
              },
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有操作记录" /> }}
          />
        </Card>
      </Section>

      <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.9 }}>
        证书由 certbot 在每天 03:17 / 15:17 自动续期，若剩余天数持续减少请检查 cron 与
        <span className="mono"> /var/log/letsencrypt</span>；备份运行日志在
        <span className="mono"> /var/log/mailer-backup.log</span>。
      </div>

      <Modal
        open={clearOpen}
        title="清除操作日志"
        okText="清除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: clearing }}
        onOk={() => void clearLogs()}
        onCancel={() => setClearOpen(false)}
        width={480}
      >
        <div style={{ fontSize: 13, lineHeight: 1.8, color: tokens.foreground }}>
          日志只用于回溯“谁在什么时候改了什么”，清除后无法恢复。
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.8, color: tokens.muted, marginBottom: metrics.gridGutter }}>
          清除动作本身会保留一条记录，便于事后确认日志是何时被清空的。
        </div>
        <Radio.Group value={clearScope} onChange={(e) => setClearScope(e.target.value)}>
          <Space direction="vertical">
            <Radio value="90">只清除 90 天前的日志</Radio>
            <Radio value="all">全部清除</Radio>
          </Space>
        </Radio.Group>
      </Modal>
    </div>
  );
}
