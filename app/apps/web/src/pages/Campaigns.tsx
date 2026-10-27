import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Drawer,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Typography,
} from 'antd';
import { MoreOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, statusOf, tokens } from '../theme';

/** 一个 A/B 变体：只改主题、或整套换模板，两者至少有一项 */
interface VariantDraft {
  label: string;
  subject: string;
  templateId?: number;
  weight: number;
}

interface VariantStat {
  label: string;
  subject: string | null;
  weight: number;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
}

interface CampaignRow {
  id: number;
  name: string;
  status: string;
  templateId: number;
  totalCount: number;
  sendIntervalSec: number;
  sendIntervalMaxSec: number | null;
  scheduledAt: string | null;
  recurrence: string | null;
  recurrenceInterval: number;
  recurrenceUntil: string | null;
  seriesId: number | null;
  deletedAt: string | null;
  variantLabels: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: Record<string, number>;
}

interface CampaignDetail extends CampaignRow {
  templateName: string | null;
  listIds: number[];
  channelIds: number[];
  channelGroupIds: number[];
  progress: number;
  variants: { label: string; subject: string | null; templateId: number | null; weight: number }[];
  variantStats: VariantStat[];
  winnerLabel: string | null;
  recentFailures: {
    id: number;
    email: string;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
  }[];
}

interface RecipientRow {
  id: number;
  email: string;
  status: string;
  variant: string | null;
  attempts: number;
  channelId: number | null;
  messageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

interface DraftState {
  name: string;
  templateId?: number;
  listIds: number[];
  channelIds: number[];
  /** 按发件分组选号；与 channelIds 二选一，分组优先 */
  channelGroupIds: number[];
  sendIntervalSec: number;
  /** 最大间隔；null = 固定间隔 */
  sendIntervalMaxSec: number | null;
  /** 空数组 = 不用 A/B */
  variants: VariantDraft[];
  /** now=保存后立即发 / later=到点由 worker 启动 */
  scheduleMode: 'now' | 'later';
  scheduledAt: string | null;
  /** 周期：none = 一次性；其余每跑完一轮自动生成下一轮 */
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly';
  recurrenceInterval: number;
  recurrenceUntil: string | null;
}

const emptyDraft = (): DraftState => ({
  name: '',
  listIds: [],
  channelIds: [],
  channelGroupIds: [],
  sendIntervalSec: 30,
  sendIntervalMaxSec: null,
  variants: [],
  scheduleMode: 'now',
  scheduledAt: null,
  recurrence: 'none',
  recurrenceInterval: 1,
  recurrenceUntil: null,
});

const RECURRENCE_OPTIONS = [
  { value: 'none', label: '不重复（一次性）' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

/** 打开 A/B 时的初始两版：A 沿用主模板主题，B 留空逼用户真的写出一个不同版本 */
function defaultVariants(tpls: TemplateOpt[], templateId?: number): VariantDraft[] {
  const main = tpls.find((t) => t.id === templateId);
  return [
    { label: 'A', subject: main?.subject ?? '', weight: 50 },
    { label: 'B', subject: '', weight: 50 },
  ];
}

interface TemplateOpt {
  id: number;
  name: string;
  subject: string;
}
interface ListOpt {
  id: number;
  name: string;
  contactCount: number;
}
interface ChannelGroupOpt {
  id: number;
  name: string;
  channelCount: number;
}

interface ChannelOpt {
  id: number;
  groupIds: number[];
  fromEmail: string;
  remaining: number;
  status: string;
  accountChannelCount?: number;
  sharedQuota?: boolean;
}

function StatusPill({ status }: { status: string }) {
  const s = statusOf(status);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 6,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

function Bar({ percent }: { percent: number }) {
  return (
    <div style={{ height: 4, background: tokens.secondary, borderRadius: 2, overflow: 'hidden' }}>
      <div
        style={{
          height: 4,
          width: `${Math.min(100, Math.max(0, percent))}%`,
          background: tokens.primary,
          borderRadius: 2,
          transition: 'width .3s ease',
        }}
      />
    </div>
  );
}

export default function Campaigns() {
  const { message, modal } = AntApp.useApp();

  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [recycleBin, setRecycleBin] = useState(false);
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [lists, setLists] = useState<ListOpt[]>([]);
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [channelGroups, setChannelGroups] = useState<ChannelGroupOpt[]>([]);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [recipients, setRecipients] = useState<{ total: number; items: RecipientRow[] }>({
    total: 0,
    items: [],
  });
  const [rPage, setRPage] = useState(1);
  const [rStatus, setRStatus] = useState<string | undefined>(undefined);
  const timerRef = useRef<number | null>(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [submitting, setSubmitting] = useState(false);

  const loadBase = useCallback(async () => {
    try {
      const [t, l, c, g] = await Promise.all([
        api<TemplateOpt[]>('/templates'),
        api<ListOpt[]>('/lists'),
        api<ChannelOpt[]>('/channels'),
        api<ChannelGroupOpt[]>('/channel-groups'),
      ]);
      setTemplates(t);
      setLists(l);
      setChannels(c);
      setChannelGroups(g);
    } catch (e: any) {
      message.error(e?.message ?? '加载基础数据失败');
    }
  }, [message]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<CampaignRow[]>(`/campaigns${recycleBin ? '?deleted=1' : ''}`));
    } catch (e: any) {
      message.error(e?.message ?? '加载任务失败');
    } finally {
      setLoading(false);
    }
  }, [message, recycleBin]);

  const loadDetail = useCallback(
    async (id: number, page = rPage, status = rStatus) => {
      try {
        const [d, r] = await Promise.all([
          api<CampaignDetail>(`/campaigns/${id}`),
          api<{ total: number; items: RecipientRow[] }>(
            `/campaigns/${id}/recipients?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`,
          ),
        ]);
        setDetail(d);
        setRecipients(r);
        return d;
      } catch (e: any) {
        message.error(e?.message ?? '加载详情失败');
        return null;
      }
    },
    [message, rPage, rStatus],
  );

  useEffect(() => {
    void loadBase();
    void loadList();
    // 支持 /campaigns?new=1 直接打开向导，方便分享"去建任务"的链接
    if (new URLSearchParams(window.location.search).get('new') === '1') {
      openWizard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBase, loadList]);

  // 发送中每 3 秒刷新一次进度，结束后停止轮询
  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (detailId === null) return;

    timerRef.current = window.setInterval(async () => {
      const d = await loadDetail(detailId);
      if (d && d.status !== 'running') {
        if (timerRef.current) window.clearInterval(timerRef.current);
        timerRef.current = null;
        void loadList();
      }
    }, 3000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [detailId, loadDetail, loadList]);

  const openDetail = async (id: number) => {
    setDetailId(id);
    setRPage(1);
    setRStatus(undefined);
    await loadDetail(id, 1, undefined);
  };

  const act = async (id: number, action: 'start' | 'pause' | 'resume' | 'cancel') => {
    try {
      const r = await api<any>(`/campaigns/${id}/${action}`, { method: 'POST' });
      if (action === 'start') {
        message.success(`已开始发送，共 ${r.total} 个收件人`);
      } else {
        message.success('已提交');
      }
      await loadList();
      if (detailId === id) await loadDetail(id);
    } catch (e: any) {
      message.error(e?.message ?? '操作失败');
    }
  };

  /**
   * 删除走"回收站"而不是直接抹掉。
   * 确认框里必须写清楚会失去什么、能不能恢复——这才是"二次确认"的意义，
   * 只问一句"确定吗"等于没问。
   */
  const remove = (row: CampaignRow) => {
    modal.confirm({
      title: `把「${row.name}」移入回收站？`,
      content: `任务会从列表中消失，${row.totalCount} 条投递明细仍然保留。可以随时恢复，也可以在回收站里彻底删除。`,
      okText: '移入回收站',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api(`/campaigns/${row.id}`, { method: 'DELETE' });
          message.success('已移入回收站');
          if (detailId === row.id) setDetailId(null);
          await loadList();
        } catch (e: any) {
          message.error(e?.message ?? '删除失败');
        }
      },
    });
  };

  const restore = async (row: CampaignRow) => {
    try {
      await api(`/campaigns/${row.id}/restore`, { method: 'POST' });
      message.success('已从回收站恢复');
      await loadList();
    } catch (e: any) {
      message.error(e?.message ?? '恢复失败');
    }
  };

  const purge = (row: CampaignRow) => {
    modal.confirm({
      title: `彻底删除「${row.name}」？`,
      content: `将永久删除该任务及其 ${row.totalCount} 条投递明细，无法恢复。如果只是想停用它，请用恢复。`,
      okText: '彻底删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api(`/campaigns/${row.id}/purge`, { method: 'POST' });
          message.success('已彻底删除');
          await loadList();
        } catch (e: any) {
          message.error(e?.message ?? '彻底删除失败');
        }
      },
    });
  };

  const stopSeries = (row: CampaignRow) => {
    modal.confirm({
      title: `停止「${row.name}」的周期？`,
      content: '这一系列不会再生成后续任务。已经发出和正在发送的邮件不受影响。',
      okText: '停止周期',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api<{ affected: number }>(`/campaigns/${row.id}/stop-series`, { method: 'POST' });
          message.success(`已停止周期（影响 ${r.affected} 轮）`);
          await loadList();
          if (detailId === row.id) await loadDetail(row.id);
        } catch (e: any) {
          message.error(e?.message ?? '操作失败');
        }
      },
    });
  };

  /** 取消排期只是把状态退回草稿，队列还没铺开，所以不涉及任何投递数据 */
  const unschedule = async (id: number) => {
    try {
      await api(`/campaigns/${id}/unschedule`, { method: 'POST' });
      message.success('已取消排期，任务回到草稿');
      await loadList();
      if (detailId === id) await loadDetail(id);
    } catch (e: any) {
      message.error(e?.message ?? '取消排期失败');
    }
  };

  // ---------- 向导 ----------

  const openWizard = () => {
    setEditingId(null);
    setStep(0);
    setDraft(emptyDraft());
    setWizardOpen(true);
    void loadBase();
  };

  const openEditDraft = async (id: number) => {
    try {
      const d = await api<CampaignDetail>(`/campaigns/${id}`);
      setEditingId(id);
      setDraft({
        name: d.name,
        templateId: d.templateId,
        listIds: d.listIds,
        channelIds: d.channelIds,
        channelGroupIds: d.channelGroupIds ?? [],
        sendIntervalSec: d.sendIntervalSec,
        sendIntervalMaxSec: d.sendIntervalMaxSec ?? null,
        variants: (d.variants ?? []).map((v) => ({
          label: v.label,
          subject: v.subject ?? '',
          templateId: v.templateId ?? undefined,
          weight: v.weight,
        })),
        scheduleMode: 'now',
        scheduledAt: d.scheduledAt,
        recurrence: (d.recurrence as DraftState['recurrence']) ?? 'none',
        recurrenceInterval: d.recurrenceInterval ?? 1,
        recurrenceUntil: d.recurrenceUntil,
      });
      setStep(0);
      setWizardOpen(true);
      await loadBase();
    } catch (e: any) {
      message.error(e?.message ?? '加载草稿失败');
    }
  };

  /**
   * 受众人数一律以服务端为准：分组人数减去抑制名单。
   * 前端把各分组 contactCount 相加会多算抑制地址，出现"显示 2 人只发 1 封"。
   */
  const [audience, setAudience] = useState<{ total: number; reachable: number; skipped: number } | null>(null);
  useEffect(() => {
    if (draft.listIds.length === 0) {
      setAudience({ total: 0, reachable: 0, skipped: 0 });
      return;
    }
    let alive = true;
    api<{ total: number; reachable: number; skipped: number }>(
      `/campaigns/audience?listIds=${draft.listIds.join(',')}`,
    )
      .then((r) => alive && setAudience(r))
      .catch(() => alive && setAudience(null));
    return () => {
      alive = false;
    };
  }, [draft.listIds]);

  const estimateCount = audience?.reachable ?? 0;

  const estimateMinutes = useMemo(() => {
    if (estimateCount === 0) return 0;
    // 发送节奏只由任务自己的间隔决定；通道没有独立间隔，服务商的硬限制由每日配额兜住
    const gap = draft.sendIntervalMaxSec && draft.sendIntervalMaxSec > draft.sendIntervalSec
      ? (draft.sendIntervalSec + draft.sendIntervalMaxSec) / 2
      : draft.sendIntervalSec;
    return Math.ceil((estimateCount * gap) / 60);
  }, [estimateCount, draft.sendIntervalSec, draft.sendIntervalMaxSec]);

  const variantsReady =
    draft.variants.length === 0 ||
    draft.variants.every((v) => v.subject.trim().length > 0 || Boolean(v.templateId));

  const canNext = () => {
    if (step === 0) return Boolean(draft.name.trim() && draft.templateId && variantsReady);
    if (step === 1) return draft.listIds.length > 0;
    if (step === 2) return draft.sendIntervalMaxSec === null || draft.sendIntervalMaxSec >= draft.sendIntervalSec;
    if (step === 3) return draft.scheduleMode === 'now' || Boolean(draft.scheduledAt);
    return true;
  };

  const submitWizard = async (mode: 'draft' | 'start' | 'schedule') => {
    setSubmitting(true);
    try {
      const payload = {
        name: draft.name.trim(),
        templateId: draft.templateId,
        listIds: draft.listIds,
        // 选了分组就不再按具体通道下发，避免两份约束互相打架
        channelIds: draft.channelGroupIds.length > 0 ? [] : draft.channelIds,
        channelGroupIds: draft.channelGroupIds,
        sendIntervalSec: draft.sendIntervalSec,
        sendIntervalMaxSec: draft.sendIntervalMaxSec ?? undefined,
        variants: draft.variants.map((v) => ({
          label: v.label,
          subject: v.subject.trim() || undefined,
          templateId: v.templateId,
          weight: v.weight,
        })),
        recurrence: draft.recurrence,
        recurrenceInterval: draft.recurrenceInterval,
        recurrenceUntil: draft.recurrence === 'none' ? undefined : draft.recurrenceUntil ?? undefined,
      };

      let id = editingId;
      if (editingId) {
        await api(`/campaigns/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        const created = await api<{ id: number }>('/campaigns', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        id = created.id;
      }

      if (mode === 'draft') {
        message.success(editingId ? '草稿已保存' : '已保存为草稿，可稍后继续编辑');
        setWizardOpen(false);
        setEditingId(null);
        await loadList();
        return;
      }

      if (mode === 'schedule') {
        const when = dayjs(draft.scheduledAt);
        const r = await api<any>(`/campaigns/${id}/schedule`, {
          method: 'POST',
          body: JSON.stringify({ scheduledAt: when.toISOString() }),
        });
        message.success(`已排期：${when.format('MM-DD HH:mm')} 自动开始，约 ${r.audience} 人`);
        setWizardOpen(false);
        setEditingId(null);
        await loadList();
        return;
      }

      const r = await api<any>(`/campaigns/${id}/start`, { method: 'POST' });
      message.success(`已开始发送，共 ${r.total} 个收件人`);
      setWizardOpen(false);
      setEditingId(null);
      await loadList();
      await openDetail(id!);
    } catch (e: any) {
      message.error(
        e?.message ?? (mode === 'start' ? '开始发送失败' : mode === 'schedule' ? '排期失败' : '保存草稿失败'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: '任务名称',
      dataIndex: 'name',
      render: (v: string, r: CampaignRow) => (
        <span>
          <a onClick={() => openDetail(r.id)} style={{ color: tokens.ink, fontWeight: 500 }}>
            {v}
          </a>
          {r.variantLabels.length > 0 && (
            <span
              style={{
                marginLeft: 6,
                padding: '0 5px',
                borderRadius: 4,
                border: `1px solid ${tokens.borderStrong}`,
                color: tokens.muted,
                fontSize: 11,
                lineHeight: '16px',
                display: 'inline-block',
              }}
              title={`A/B：${r.variantLabels.join(' / ')}`}
            >
              A/B
            </span>
          )}
          {r.recurrence && (
            <span
              style={{
                marginLeft: 6,
                padding: '0 5px',
                borderRadius: 4,
                border: `1px solid ${tokens.borderStrong}`,
                color: tokens.primary,
                fontSize: 11,
                lineHeight: '16px',
                display: 'inline-block',
              }}
              title={`周期：${r.recurrence}，间隔 ${r.recurrenceInterval}`}
            >
              周期
            </span>
          )}
        </span>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <StatusPill status={v} /> },
    {
      title: '计划发送',
      width: 108,
      render: (_: unknown, r: CampaignRow) =>
        r.scheduledAt ? (
          <span
            style={{
              fontSize: 12,
              color: r.status === 'scheduled' ? tokens.primary : tokens.muted,
            }}
          >
            {dayjs(r.scheduledAt).format('MM-DD HH:mm')}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: tokens.muted }}>—</span>
        ),
    },
    {
      title: '进度',
      width: 200,
      render: (_: unknown, r: CampaignRow) => {
        const sent = r.counts.sent ?? 0;
        const failed = r.counts.failed ?? 0;
        const canceled = r.counts.canceled ?? 0;
        const total = r.totalCount || 0;
        const pct = total > 0 ? Math.round(((sent + failed + canceled) / total) * 100) : 0;
        return (
          <div>
            <Bar percent={pct} />
            <div style={{ fontSize: 11, color: tokens.muted, marginTop: 4 }}>
              {pct}% · 已发 {sent}/{total}
            </div>
          </div>
        );
      },
    },
    {
      title: '结果',
      width: 170,
      render: (_: unknown, r: CampaignRow) => {
        const f = r.counts.failed ?? 0;
        return (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: tokens.successDeep }}>送达 {r.counts.sent ?? 0}</span>
            {f > 0 && <span style={{ color: tokens.destructive, marginLeft: 8 }}>失败 {f}</span>}
          </span>
        );
      },
    },
    {
      title: '间隔',
      width: 96,
      render: (_: unknown, r: CampaignRow) => (
        <span style={{ fontSize: 12, color: tokens.muted }}>
          {r.sendIntervalMaxSec && r.sendIntervalMaxSec > r.sendIntervalSec
            ? `${r.sendIntervalSec}–${r.sendIntervalMaxSec}s`
            : `${r.sendIntervalSec}s`}
        </span>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 120,
      render: (v: string) => (
        <span style={{ fontSize: 12, color: tokens.muted }}>{dayjs(v).format('MM-DD HH:mm')}</span>
      ),
    },
    {
      title: '操作',
      width: 200,
      render: (_: unknown, r: CampaignRow) => {
        // 回收站里只提供"恢复"和"彻底删除"，没有第三种选择
        if (r.deletedAt) {
          return (
            <Space size={4}>
              <Button size="small" onClick={() => void restore(r)}>
                恢复
              </Button>
              <Button size="small" danger type="text" onClick={() => purge(r)}>
                彻底删除
              </Button>
            </Space>
          );
        }

        // 主操作留按钮，其余收进「更多」：一行五个文字按钮会把列撑成三行
        const more: { key: string; label: string; danger?: boolean }[] = [];
        if (r.status === 'draft') more.push({ key: 'edit', label: '编辑' });
        if (r.status === 'scheduled') more.push({ key: 'unschedule', label: '取消排期' });
        if (r.recurrence) more.push({ key: 'stopSeries', label: '停止周期' });
        if (['draft', 'scheduled', 'paused', 'canceled', 'done'].includes(r.status)) {
          more.push({ key: 'delete', label: '删除', danger: true });
        }

        const onMore = (key: string) => {
          if (key === 'edit') void openEditDraft(r.id);
          else if (key === 'unschedule') void unschedule(r.id);
          else if (key === 'stopSeries') stopSeries(r);
          else if (key === 'delete') remove(r);
        };

        return (
          <Space size={4}>
            {r.status === 'draft' && (
              <Button size="small" type="primary" onClick={() => act(r.id, 'start')}>
                开始
              </Button>
            )}
            {r.status === 'running' && (
              <Button size="small" onClick={() => act(r.id, 'pause')}>
                暂停
              </Button>
            )}
            {r.status === 'paused' && (
              <Button size="small" type="primary" onClick={() => act(r.id, 'resume')}>
                继续
              </Button>
            )}
            {r.status === 'scheduled' && (
              <Button size="small" type="primary" onClick={() => act(r.id, 'start')}>
                立即开始
              </Button>
            )}
            <Button size="small" onClick={() => openDetail(r.id)}>
              详情
            </Button>
            {more.length > 0 && (
              <Dropdown menu={{ items: more, onClick: ({ key }) => onMore(key) }} trigger={['click']}>
                <Button size="small" type="text" icon={<MoreOutlined />} />
              </Dropdown>
            )}
          </Space>
        );
      },
    },
  ];

  const detailCounts = detail?.counts ?? {};
  const recipientColumns = [
    { title: '收件人', dataIndex: 'email', render: (v: string) => <span className="mono">{v}</span> },
    ...(detail && detail.variantStats.length > 0
      ? [
          {
            title: '变体',
            dataIndex: 'variant',
            width: 56,
            render: (v: string | null) => (
              <span style={{ fontSize: 12, color: tokens.muted }}>{v ?? '—'}</span>
            ),
          },
        ]
      : []),
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <StatusPill status={v} />,
    },
    { title: '尝试', dataIndex: 'attempts', width: 60 },
    {
      title: '结果',
      render: (_: unknown, r: RecipientRow) =>
        r.errorCode ? (
          <span style={{ fontSize: 12, color: tokens.destructive }} title={r.errorMessage ?? ''}>
            {r.errorCode}
          </span>
        ) : r.sentAt ? (
          <span style={{ fontSize: 12, color: tokens.muted }}>{dayjs(r.sentAt).format('MM-DD HH:mm')}</span>
        ) : (
          <span style={{ fontSize: 12, color: tokens.muted }}>—</span>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="群发任务"
        desc="按批次组织收件人，支持定时与周期发送"
        note={
          recycleBin ? (
            <span style={{ fontSize: 12, color: tokens.warning }}>
              正在查看回收站：这里的任务不会发送，恢复后回到列表
            </span>
          ) : undefined
        }
        extra={
          <>
            <Space size={8}>
              <span style={{ fontSize: 12, color: tokens.muted }}>回收站</span>
              <Switch size="small" checked={recycleBin} onChange={setRecycleBin} />
            </Space>
            <Button icon={<ReloadOutlined />} onClick={loadList} />
            {!recycleBin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openWizard}>
                新建任务
              </Button>
            )}
          </>
        }
      />

      <Section title="任务列表" desc="发出去之后可以随时暂停，已发出的不受影响">
        <Card className="card-table">
          <Table<CampaignRow>
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns as any}
            scroll={{ x: 1240 }}
            tableLayout="fixed"
            pagination={false}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span style={{ fontSize: 13, color: tokens.muted }}>还没有群发任务</span>
                  }
                />
              ),
            }}
          />
        </Card>
      </Section>

      {/* ---------- 四步向导 ---------- */}
      <Modal
        open={wizardOpen}
        onCancel={() => setWizardOpen(false)}
        width={720}
        title={editingId ? '编辑群发任务草稿' : '新建群发任务'}
        destroyOnClose
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
            {step < 3 && (
              <Button type="primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>
                下一步
              </Button>
            )}
            {step === 3 && (
              <>
                <Button loading={submitting} onClick={() => submitWizard('draft')}>
                  {editingId ? '保存修改' : '保存草稿'}
                </Button>
                {draft.scheduleMode === 'later' ? (
                  <Button
                    type="primary"
                    loading={submitting}
                    disabled={!draft.scheduledAt}
                    onClick={() => submitWizard('schedule')}
                  >
                    保存并排期
                  </Button>
                ) : (
                  <Button type="primary" loading={submitting} onClick={() => submitWizard('start')}>
                    保存并开始
                  </Button>
                )}
              </>
            )}
          </div>
        }
      >
        <Steps
          current={step}
          size="small"
          style={{ marginBottom: 20 }}
          items={[{ title: '基本信息' }, { title: '选择分组' }, { title: '账号与节流' }, { title: '确认' }]}
        />

        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 6 }}>任务名称</div>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如：老客户回访-11月"
              />
            </div>
            <div>
              <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 6 }}>邮件模板</div>
              <Select
                style={{ width: '100%' }}
                placeholder="选择一个模板"
                value={draft.templateId}
                onChange={(v) => setDraft({ ...draft, templateId: v })}
                options={templates.map((t) => ({
                  value: t.id,
                  label: `${t.name} — ${t.subject}`,
                }))}
              />
              {templates.length === 0 && (
                <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6 }}>
                  还没有模板，请先到「邮件模板」创建
                </div>
              )}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 13, color: tokens.ink }}>A/B 测试</div>
                  <div style={{ fontSize: 12, color: tokens.muted, marginTop: 2 }}>
                    按权重把收件人分成两版发送，发完在详情里对比打开率
                  </div>
                </div>
                <Switch
                  checked={draft.variants.length > 0}
                  onChange={(on) =>
                    setDraft({ ...draft, variants: on ? defaultVariants(templates, draft.templateId) : [] })
                  }
                />
              </div>

              {draft.variants.length > 0 && (
                <div style={{ marginTop: 10, border: `1px solid ${tokens.border}`, borderRadius: 8 }}>
                  {draft.variants.map((v, i) => (
                    <div
                      key={v.label}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                      }}
                    >
                      <span style={{ width: 16, fontSize: 13, fontWeight: 500, color: tokens.ink }}>
                        {v.label}
                      </span>
                      <Input
                        size="small"
                        placeholder="这一版的主题，留空则用模板主题"
                        value={v.subject}
                        onChange={(e) => {
                          const next = [...draft.variants];
                          next[i] = { ...next[i], subject: e.target.value };
                          setDraft({ ...draft, variants: next });
                        }}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Select
                        size="small"
                        allowClear
                        placeholder="模板"
                        style={{ width: 130 }}
                        value={v.templateId}
                        onChange={(val) => {
                          const next = [...draft.variants];
                          next[i] = { ...next[i], templateId: val };
                          setDraft({ ...draft, variants: next });
                        }}
                        options={templates.map((t) => ({ value: t.id, label: t.name }))}
                      />
                      <InputNumber
                        size="small"
                        min={1}
                        max={100}
                        value={v.weight}
                        onChange={(val) => {
                          const next = [...draft.variants];
                          next[i] = { ...next[i], weight: val ?? 50 };
                          setDraft({ ...draft, variants: next });
                        }}
                        style={{ width: 72 }}
                      />
                    </div>
                  ))}
                  <div
                    style={{
                      padding: '8px 12px',
                      borderTop: `1px solid ${tokens.border}`,
                      fontSize: 12,
                      color: tokens.muted,
                    }}
                  >
                    每一版必须改主题或换模板；权重按组内归一化，不要求凑成 100（{draft.variants
                      .map((v) => `${v.label} ${v.weight}`)
                      .join(' : ')}
                    ）。
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <div style={{ fontSize: 13, color: tokens.muted, marginBottom: 10 }}>
              只发送可投递的联系人；抑制名单（退信、投诉等）里的地址会被自动跳过。
            </div>
            {lists.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分组" />
            ) : (
              <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8 }}>
                {lists.map((l, i) => (
                  <div
                    key={l.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 14px',
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                    }}
                  >
                    <Checkbox
                      checked={draft.listIds.includes(l.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          listIds: e.target.checked
                            ? [...draft.listIds, l.id]
                            : draft.listIds.filter((x) => x !== l.id),
                        })
                      }
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{l.name}</span>
                    <span style={{ fontSize: 12, color: tokens.muted }}>{l.contactCount} 人</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 6 }}>
                发件分组（留空表示自动选择）
              </div>
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="不选则由系统按配额自动分配"
                value={draft.channelGroupIds}
                onChange={(v) => setDraft({ ...draft, channelGroupIds: v })}
                options={channelGroups.map((g) => {
                  const inGroup = channels.filter((c) => c.groupIds.includes(g.id));
                  const remaining = inGroup.reduce((s, c) => Math.max(s, c.remaining), 0);
                  return {
                    value: g.id,
                    label: `${g.name}（${inGroup.length} 条通道，账号今日最多剩 ${remaining}）`,
                  };
                })}
              />
              {channelGroups.length === 0 && (
                <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6 }}>
                  还没有发件分组，请先到「发件账号」里把通道归组；不分组时任务会按配额自动分配。
                </div>
              )}
              {draft.channelIds.length > 0 && draft.channelGroupIds.length === 0 && (
                <div style={{ fontSize: 12, color: tokens.warning, marginTop: 6 }}>
                  该任务按具体通道指定（旧任务）：选择发件分组后会改为按分组下发。
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 6 }}>任务内发送间隔</div>
              <Space align="center" size={8} wrap>
                <InputNumber
                  min={1}
                  max={3600}
                  value={draft.sendIntervalSec}
                  onChange={(v) => setDraft({ ...draft, sendIntervalSec: v ?? 30 })}
                  addonBefore="最小"
                  addonAfter="秒"
                  style={{ width: 190 }}
                />
                <span style={{ color: tokens.muted }}>—</span>
                <InputNumber
                  min={1}
                  max={3600}
                  value={draft.sendIntervalMaxSec}
                  placeholder="不填即固定"
                  onChange={(v) => setDraft({ ...draft, sendIntervalMaxSec: v ?? null })}
                  addonBefore="最大"
                  addonAfter="秒"
                  style={{ width: 190 }}
                  status={
                    draft.sendIntervalMaxSec !== null && draft.sendIntervalMaxSec < draft.sendIntervalSec
                      ? 'error'
                      : undefined
                  }
                />
              </Space>
              <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6 }}>
                {draft.sendIntervalMaxSec && draft.sendIntervalMaxSec >= draft.sendIntervalSec
                  ? `每封之间在 ${draft.sendIntervalSec}–${draft.sendIntervalMaxSec} 秒内随机，节奏更像真人，也更不容易被判定为批量群发。`
                  : '只填最小间隔就是固定间隔。填上最大间隔后，每封之间会在区间内随机；实际发送节奏只由这里的间隔决定。'}
                {draft.sendIntervalMaxSec !== null && draft.sendIntervalMaxSec < draft.sendIntervalSec && (
                  <span style={{ color: tokens.destructive }}> 最大间隔不能小于最小间隔。</span>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 8 }}>发送时间</div>
              <Radio.Group
                value={draft.scheduleMode}
                onChange={(e) => setDraft({ ...draft, scheduleMode: e.target.value })}
              >
                <Radio value="now">保存后立即开始</Radio>
                <Radio value="later">定时发送</Radio>
              </Radio.Group>
              {draft.scheduleMode === 'later' && (
                <div style={{ marginTop: 10 }}>
                  <DatePicker
                    showTime={{ format: 'HH:mm' }}
                    format="YYYY-MM-DD HH:mm"
                    value={draft.scheduledAt ? dayjs(draft.scheduledAt) : null}
                    onChange={(val) => setDraft({ ...draft, scheduledAt: val ? val.toISOString() : null })}
                    disabledDate={(d) => Boolean(d) && d.endOf('day').valueOf() < Date.now()}
                    placeholder="选择日期和时间"
                  />
                  <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6, lineHeight: 1.6 }}>
                    到点由发送进程启动，检查间隔 30 秒。排期后收件人还没有确定，
                    届时按当时的联系人名单展开——这期间新增的抑制地址不会收到。
                  </div>
                </div>
              )}

              <div style={{ marginTop: 14, borderTop: `1px solid ${tokens.border}`, paddingTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: tokens.ink, width: 48 }}>重复</span>
                  <Select
                    size="small"
                    style={{ width: 160 }}
                    value={draft.recurrence}
                    onChange={(v) => setDraft({ ...draft, recurrence: v })}
                    options={RECURRENCE_OPTIONS}
                  />
                  {draft.recurrence !== 'none' && (
                    <>
                      <span style={{ fontSize: 12, color: tokens.muted }}>间隔</span>
                      <InputNumber
                        size="small"
                        min={1}
                        max={52}
                        value={draft.recurrenceInterval}
                        onChange={(v) => setDraft({ ...draft, recurrenceInterval: v ?? 1 })}
                        style={{ width: 70 }}
                      />
                      <span style={{ fontSize: 12, color: tokens.muted }}>
                        {draft.recurrence === 'daily' ? '天' : draft.recurrence === 'weekly' ? '周' : '月'}一轮
                      </span>
                      <DatePicker
                        size="small"
                        placeholder="截止日期（可留空）"
                        value={draft.recurrenceUntil ? dayjs(draft.recurrenceUntil) : null}
                        onChange={(v) => setDraft({ ...draft, recurrenceUntil: v ? v.toISOString() : null })}
                      />
                    </>
                  )}
                </div>
                {draft.recurrence !== 'none' && (
                  <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6, lineHeight: 1.6 }}>
                    每跑完一轮，系统按计划时间自动生成下一轮；收件人在那一轮启动时才展开。
                    想停下来就在任务列表里点「停止周期」。
                  </div>
                )}
              </div>
            </div>

            <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8 }}>
              {[
                ['任务名称', draft.name],
                ['使用模板', templates.find((t) => t.id === draft.templateId)?.name ?? '—'],
                ...(draft.variants.length > 0
                  ? [
                      [
                        'A/B 变体',
                        draft.variants
                          .map((v) => `${v.label}：${v.subject || '（用模板主题）'} · 权重 ${v.weight}`)
                          .join('；'),
                      ],
                    ]
                  : []),
                [
                  '收件分组',
                  lists
                    .filter((l) => draft.listIds.includes(l.id))
                    .map((l) => `${l.name}(${l.contactCount})`)
                    .join('、') || '—',
                ],
                [
                  '发件分组',
                  draft.channelGroupIds.length
                    ? channelGroups
                        .filter((g) => draft.channelGroupIds.includes(g.id))
                        .map((g) => g.name)
                        .join('、')
                    : draft.channelIds.length
                      ? `按通道指定（${draft.channelIds.length} 条）`
                      : '自动分配',
                ],
                [
                  '发送间隔',
                  draft.sendIntervalMaxSec && draft.sendIntervalMaxSec > draft.sendIntervalSec
                    ? `随机 ${draft.sendIntervalSec}–${draft.sendIntervalMaxSec} 秒`
                    : `${draft.sendIntervalSec} 秒`,
                ],
                [
                  '预计收件人',
                  audience && audience.skipped > 0
                    ? `约 ${estimateCount} 人（另有 ${audience.skipped} 个地址在抑制名单，不会发送）`
                    : `约 ${estimateCount} 人`,
                ],
                ['预计耗时', estimateMinutes > 0 ? `约 ${estimateMinutes} 分钟` : '—'],
                [
                  '发送时间',
                  draft.scheduleMode === 'later' && draft.scheduledAt
                    ? dayjs(draft.scheduledAt).format('YYYY-MM-DD HH:mm')
                    : '保存后立即开始',
                ],
                ...(draft.recurrence !== 'none'
                  ? [
                      [
                        '重复',
                        `${
                          RECURRENCE_OPTIONS.find((o) => o.value === draft.recurrence)?.label ?? ''
                        }，间隔 ${draft.recurrenceInterval}${
                          draft.recurrenceUntil
                            ? `，截止 ${dayjs(draft.recurrenceUntil).format('YYYY-MM-DD')}`
                            : ''
                        }`,
                      ],
                    ]
                  : []),
              ].map(([k, v], i) => (
                <div
                  key={k as string}
                  style={{
                    display: 'flex',
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                    fontSize: 13,
                  }}
                >
                  <span style={{ width: 96, color: tokens.muted, flexShrink: 0 }}>{k}</span>
                  <span style={{ color: tokens.ink, minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- 任务详情 ---------- */}
      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        width={720}
        destroyOnClose
        title={
          <Space size={10}>
            <span>{detail?.name ?? '任务详情'}</span>
            {detail && <StatusPill status={detail.status} />}
          </Space>
        }
        extra={
          detail && (
            <Space>
              {detail.status === 'running' && (
                <Button size="small" onClick={() => act(detail.id, 'pause')}>
                  暂停
                </Button>
              )}
              {detail.status === 'paused' && (
                <Button size="small" type="primary" onClick={() => act(detail.id, 'resume')}>
                  继续
                </Button>
              )}
              {detail.status === 'scheduled' && (
                <>
                  <Button size="small" onClick={() => void unschedule(detail.id)}>
                    取消排期
                  </Button>
                  <Button size="small" type="primary" onClick={() => act(detail.id, 'start')}>
                    立即开始
                  </Button>
                </>
              )}
              {(detail.status === 'running' || detail.status === 'paused') && (
                <Popconfirm
                  title="取消后未发送的收件人将不再发送"
                  onConfirm={() => act(detail.id, 'cancel')}
                  okText="确认取消"
                  cancelText="返回"
                >
                  <Button size="small" danger>
                    取消任务
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )
        }
      >
        {detail && (
          <>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              {[
                ['已送达', detailCounts.sent ?? 0, tokens.successDeep],
                ['失败', detailCounts.failed ?? 0, detailCounts.failed ? tokens.destructive : tokens.muted],
                ['待发送', detailCounts.queued ?? 0, tokens.muted],
                ['已取消', detailCounts.canceled ?? 0, tokens.muted],
              ].map(([label, value, color]) => (
                <div key={label as string} style={{ minWidth: 72 }}>
                  <div style={{ fontSize: 11, color: tokens.muted }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 500, color: color as string, lineHeight: 1.3 }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>

            <Bar percent={detail.progress} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: tokens.muted, margin: '6px 0 16px' }}>
              <span>
                {detail.progress}% · 共 {detail.totalCount} 人
              </span>
              <span>
                {detail.finishedAt
                  ? `完成于 ${dayjs(detail.finishedAt).format('MM-DD HH:mm')}`
                  : detail.startedAt
                    ? `开始于 ${dayjs(detail.startedAt).format('MM-DD HH:mm')}`
                    : detail.status === 'scheduled' && detail.scheduledAt
                      ? `计划 ${dayjs(detail.scheduledAt).format('MM-DD HH:mm')} 自动开始`
                      : '未开始'}
              </span>
            </div>

            {detail.variantStats.length > 0 && (
              <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, marginBottom: 16 }}>
                <div
                  style={{
                    padding: '8px 14px',
                    borderBottom: `1px solid ${tokens.border}`,
                    fontSize: 13,
                    color: tokens.ink,
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>A/B 对比</span>
                  <span
                    style={{
                      fontSize: 12,
                      color: detail.winnerLabel ? tokens.successDeep : tokens.muted,
                    }}
                  >
                    {detail.winnerLabel
                      ? `打开率更高：${detail.winnerLabel}`
                      : '样本不足，暂不下结论'}
                  </span>
                </div>
                {detail.variantStats.map((v, i) => (
                  <div
                    key={v.label}
                    style={{
                      padding: '8px 14px',
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                      fontSize: 12,
                      display: 'flex',
                      gap: 10,
                      alignItems: 'baseline',
                    }}
                  >
                    <span style={{ fontWeight: 500, color: tokens.ink, width: 14 }}>{v.label}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: tokens.muted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={v.subject ?? ''}
                    >
                      {v.subject || '（用模板主题）'} · 权重 {v.weight}
                    </span>
                    <span style={{ width: 54, textAlign: 'right' }}>已发 {v.sent}</span>
                    <span style={{ width: 62, textAlign: 'right' }}>打开 {v.openRate}%</span>
                    <span style={{ width: 62, textAlign: 'right' }}>点击 {v.clickRate}%</span>
                  </div>
                ))}
              </div>
            )}

            {detail.recentFailures.length > 0 && (
              <div
                style={{
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  marginBottom: 16,
                }}
              >
                <div style={{ padding: '8px 14px', borderBottom: `1px solid ${tokens.border}`, fontSize: 13, color: tokens.ink }}>
                  最近失败（{detail.recentFailures.length}）
                </div>
                {detail.recentFailures.map((f, i) => (
                  <div
                    key={f.id}
                    style={{
                      padding: '8px 14px',
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span className="mono" style={{ color: tokens.ink }}>
                        {f.email}
                      </span>
                      <span style={{ color: tokens.muted }}>尝试 {f.attempts} 次</span>
                      <span style={{ color: tokens.destructive }}>{f.errorCode}</span>
                    </div>
                    <div style={{ color: tokens.muted, marginTop: 2 }}>{f.errorMessage}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: tokens.ink }}>投递明细</div>
              <Select
                size="small"
                allowClear
                placeholder="全部状态"
                style={{ width: 120 }}
                value={rStatus}
                onChange={(v) => {
                  setRStatus(v);
                  setRPage(1);
                  void loadDetail(detail.id, 1, v);
                }}
                options={['sent', 'failed', 'queued', 'canceled'].map((s) => ({
                  value: s,
                  label: statusOf(s).label,
                }))}
              />
            </div>
            <Table<RecipientRow>
              rowKey="id"
              size="small"
              dataSource={recipients.items}
              columns={recipientColumns as any}
              pagination={{
                current: rPage,
                pageSize: 20,
                total: recipients.total,
                showSizeChanger: false,
                showTotal: (t) => `共 ${t} 条`,
                onChange: (p) => {
                  setRPage(p);
                  void loadDetail(detail.id, p, rStatus);
                },
              }}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
