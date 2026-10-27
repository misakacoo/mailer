import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import { metrics, tokens } from '../theme';

interface ChannelGroupRow {
  id: number;
  name: string;
  note: string | null;
  channelCount: number;
}

interface ChannelRow {
  id: number;
  name: string;
  groupIds: number[];
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string | null;
  fromEmail: string;
  replyTo: string | null;
  dailyLimit: number;
  sentToday: number;
  remaining: number;
  minIntervalSec: number;
  priority: number;
  status: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
  lastSentAt: string | null;
  hasPassword: boolean;
  accountKey: string;
  accountChannelCount: number;
  sharedQuota: boolean;
  accountLimit: number;
  accountUsed: number;
  accountRemaining: number;
}

interface Preset {
  key: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  hint: string;
}

interface ChannelForm {
  preset?: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  fromName?: string;
  fromEmail: string;
  replyTo?: string;
  dailyLimit: number;
  minIntervalSec: number;
  priority: number;
  groupIds?: number[];
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  active: { color: 'green', text: '正常' },
  paused: { color: 'default', text: '已停用' },
  error: { color: 'red', text: '异常' },
};

export default function Channels() {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [groups, setGroups] = useState<ChannelGroupRow[]>([]);
  const [groupFilter, setGroupFilter] = useState<number | 'all' | 'none'>('all');
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | 'new' | null>(null);
  const [form] = Form.useForm<ChannelForm>();
  const [testTarget, setTestTarget] = useState<{ channel: ChannelRow } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, ps, gs] = await Promise.all([
        api<ChannelRow[]>('/channels'),
        api<Preset[]>('/channels/presets'),
        api<ChannelGroupRow[]>('/channel-groups'),
      ]);
      setRows(list);
      setPresets(ps);
      setGroups(gs);
    } catch (e: any) {
      message.error(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const qq = presets.find((p) => p.key === 'stackmail') ?? presets[0];
    form.setFieldsValue({
      preset: qq?.key,
      host: qq?.host,
      port: qq?.port ?? 465,
      secure: qq?.secure ?? true,
      dailyLimit: 50,
      minIntervalSec: 30,
      priority: 0,
    });
    setFormOpen(true);
  };

  const openEdit = (row: ChannelRow) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: '',
      fromName: row.fromName ?? undefined,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo ?? undefined,
      dailyLimit: row.dailyLimit,
      minIntervalSec: row.minIntervalSec,
      priority: row.priority,
      groupIds: row.groupIds ?? [],
    });
    setFormOpen(true);
  };

  const onPresetChange = (key: string) => {
    const p = presets.find((x) => x.key === key);
    if (!p) return;
    form.setFieldsValue({ host: p.host, port: p.port, secure: p.secure });
  };

  // ---------- 发件分组 ----------

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) {
      message.warning('请填写分组名称');
      return;
    }
    setGroupBusy(true);
    try {
      await api('/channel-groups', { method: 'POST', body: JSON.stringify({ name }) });
      setNewGroupName('');
      message.success('已创建分组');
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '创建失败');
    } finally {
      setGroupBusy(false);
    }
  };

  const renameGroup = async (g: ChannelGroupRow, name: string) => {
    if (!name.trim() || name.trim() === g.name) return;
    try {
      await api(`/channel-groups/${g.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      message.success('已重命名');
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '重命名失败');
    }
  };

  const removeGroup = async (g: ChannelGroupRow) => {
    try {
      const r = await api<{ ungrouped: number }>(`/channel-groups/${g.id}`, { method: 'DELETE' });
      message.success(r.ungrouped > 0 ? `已删除分组，${r.ungrouped} 条通道变为未分组` : '已删除分组');
      setGroupFilter('all');
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '删除失败');
    }
  };

  const submit = async (values: ChannelForm) => {
    setSaving(true);
    try {
      const body = { ...values };
      delete body.preset;
      if (editing) {
        if (!body.password) delete body.password;
        await api(`/channels/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        message.success('已保存');
      } else {
        const created = await api<ChannelRow>('/channels', { method: 'POST', body: JSON.stringify(body) });
        message.success(
          created.sharedQuota
            ? `已添加发信身份；该 SMTP 账号已有 ${created.accountChannelCount} 条通道，共用 ${created.accountLimit} 封/天`
            : '已添加发件账号',
        );
      }
      setFormOpen(false);
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 保存前先测通，避免存进一堆连不上的账号 */
  const testFromForm = async () => {
    let values: ChannelForm;
    try {
      values = await form.validateFields(['host', 'port', 'secure', 'username', 'password']);
    } catch {
      return;
    }
    setTesting('new');
    try {
      const r = await api<{ ok: boolean; message: string; elapsedMs: number }>('/channels/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          host: values.host,
          port: values.port,
          secure: values.secure,
          username: values.username,
          password: values.password || (editing ? '__stored__' : undefined),
          ...(editing ? { id: editing.id } : {}),
        }),
      });
      r.ok ? message.success(r.message) : message.error(r.message);
    } catch (e: any) {
      message.error(e?.message ?? '测试失败');
    } finally {
      setTesting(null);
    }
  };

  const testRow = async (row: ChannelRow) => {
    setTesting(row.id);
    try {
      const r = await api<{ ok: boolean; message: string }>('/channels/test-connection', {
        method: 'POST',
        body: JSON.stringify({ id: row.id }),
      });
      r.ok ? message.success(r.message) : message.error(r.message);
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '测试失败');
    } finally {
      setTesting(null);
    }
  };

  const doTestSend = async () => {
    if (!testTarget) return;
    setTestSending(true);
    try {
      const r = await api<{ ok: boolean; message: string; messageId?: string }>(
        `/channels/${testTarget.channel.id}/test-send`,
        { method: 'POST', body: JSON.stringify({ to: testTo }) },
      );
      if (r.ok) {
        message.success(r.message);
        setTestTarget(null);
        await load();
      } else {
        message.error(r.message);
      }
    } catch (e: any) {
      message.error(e?.message ?? '发送失败');
    } finally {
      setTestSending(false);
    }
  };

  const duplicate = async (row: ChannelRow) => {
    try {
      const created = await api<ChannelRow>(`/channels/${row.id}/duplicate`, { method: 'POST' });
      message.success(`已复制发信身份；配额仍与同账号的 ${created.accountChannelCount} 条通道共享`);
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '复制失败');
    }
  };

  const toggleStatus = async (row: ChannelRow, on: boolean) => {
    try {
      await api(`/channels/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: on ? 'active' : 'paused' }),
      });
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '操作失败');
    }
  };

  const remove = async (row: ChannelRow) => {
    try {
      await api(`/channels/${row.id}`, { method: 'DELETE' });
      message.success('已删除');
      await load();
    } catch (e: any) {
      modal.error({ title: '删除失败', content: e?.message ?? '未知错误' });
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 190,
      render: (v: string, r: ChannelRow) => (
        <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
          <Typography.Text strong ellipsis={{ tooltip: v }}>
            {v}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: r.fromEmail }}>
            {r.fromEmail}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '分组',
      width: 160,
      render: (_: unknown, r: ChannelRow) => {
        // 只渲染还存在的分组：分组被删后可能留下悬空 id
        const known = r.groupIds.filter((gid) => groups.some((g) => g.id === gid));
        return known.length > 0 ? (
          <Space size={4} wrap>
            {known.map((gid) => (
              <Tag key={gid} bordered={false} color="gold" style={{ marginInlineEnd: 0 }}>
                {groups.find((g) => g.id === gid)?.name}
              </Tag>
            ))}
          </Space>
        ) : (
          <span style={{ fontSize: 12, color: tokens.muted }}>未分组</span>
        );
      },
    },
    {
      title: 'SMTP',
      width: 214,
      render: (_: unknown, r: ChannelRow) => (
        <Space direction="vertical" size={2}>
          <Space size={6}>
            <span className="mono">{r.host}:{r.port}</span>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
              {r.secure ? 'SSL' : 'STARTTLS'}
            </Tag>
          </Space>
          <span className="mono" style={{ fontSize: 11, color: tokens.muted }}>
            {r.username}
          </span>
        </Space>
      ),
    },
    {
      title: '账号今日配额',
      width: 200,
      render: (_: unknown, r: ChannelRow) => {
        const percent = Math.min(100, Math.round((r.sentToday / Math.max(1, r.dailyLimit)) * 100));
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Progress
              percent={percent}
              size="small"
              showInfo={false}
              status={r.remaining === 0 ? 'exception' : 'normal'}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {r.sentToday} / {r.dailyLimit}
              </span>
              <span style={{ color: r.remaining === 0 ? tokens.destructive : tokens.muted }}>
                剩 {r.remaining}
              </span>
            </div>
            {r.sharedQuota && (
              <span style={{ fontSize: 11, color: tokens.muted }}>
                与另外 {r.accountChannelCount - 1} 条通道共享额度
              </span>
            )}
          </Space>
        );
      },
    },
    {
      title: '间隔',
      dataIndex: 'minIntervalSec',
      width: 80,
      render: (v: number) => `${v}s`,
    },
    {
      title: '状态',
      width: 140,
      render: (_: unknown, r: ChannelRow) => {
        const t = STATUS_TAG[r.status] ?? { color: 'default', text: r.status };
        const tag = (
          <Tag color={t.color} style={{ marginInlineEnd: 0 }}>
            {t.text}
          </Tag>
        );
        return (
          <Space size={8} align="center">
            {r.lastError ? (
              <Tooltip title={r.lastError}>
                <span>{tag}</span>
              </Tooltip>
            ) : (
              tag
            )}
            <Tooltip title={r.status === 'paused' ? '停用中，不参与发送' : '停用后不再参与发送'}>
              <Switch size="small" checked={r.status !== 'paused'} onChange={(v) => toggleStatus(r, v)} />
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: '最近',
      width: 150,
      render: (_: unknown, r: ChannelRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }} type="secondary">
            成功 {r.lastOkAt ? dayjs(r.lastOkAt).format('MM-DD HH:mm') : '—'}
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12 }} type={r.lastError ? 'danger' : 'secondary'}>
            失败 {r.lastErrorAt ? dayjs(r.lastErrorAt).format('MM-DD HH:mm') : '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 232,
      render: (_: unknown, r: ChannelRow) => (
        <Space size={2}>
          {/* 只有「测试连接」保留文字：它是这一页最常用的动作，
              其余四个都是低频操作，收成图标 + 悬浮说明，列宽才够用 */}
          <Button size="small" loading={testing === r.id} onClick={() => testRow(r)}>
            测试连接
          </Button>
          <Tooltip title="发一封测试邮件">
            <Button
              size="small"
              type="text"
              icon={<SendOutlined />}
              onClick={() => {
                setTestTarget({ channel: r });
                setTestTo(r.fromEmail);
              }}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Tooltip title="复制发信身份（共享账号配额）">
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => duplicate(r)} />
          </Tooltip>
          <Popconfirm title="确认删除这条通道？" onConfirm={() => remove(r)} okText="删除" cancelText="取消">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const accountCount = new Set(rows.map((r) => r.accountKey)).size;
  const shownRows =
    groupFilter === 'all'
      ? rows
      : groupFilter === 'none'
        ? rows.filter((r) => r.groupIds.length === 0)
        : rows.filter((r) => r.groupIds.includes(groupFilter as number));

  return (
    <div className="page">
      <PageHeader
        title="发件账号"
        desc={`共 ${rows.length} 条通道 · ${accountCount} 个真实 SMTP 账号，可按业务线分组，任务里按分组选号`}
        extra={
          <>
            <Select
              style={{ width: 176 }}
              value={groupFilter}
              onChange={setGroupFilter}
              options={[
                { value: 'all', label: `全部分组（${rows.length}）` },
                { value: 'none', label: `未分组（${rows.filter((r) => r.groupIds.length === 0).length}）` },
                ...groups.map((g) => ({ value: g.id, label: `${g.name}（${g.channelCount}）` })),
              ]}
            />
            <Button onClick={() => setGroupModalOpen(true)}>管理分组</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增账号
            </Button>
          </>
        }
      />

      <Section
        title="通道列表"
        desc="配额按真实邮箱账号计算：同一 SMTP 账号下的多条通道共用一个每日配额与发送间隔，拆成多条只改变发信身份，不会增加额度。"
      >
        <Card className="card-table">
          <Table<ChannelRow>
            rowKey="id"
            loading={loading}
            dataSource={shownRows}
            columns={columns as any}
            scroll={{ x: 1352 }}
            tableLayout="fixed"
            pagination={false}
            locale={{ emptyText: '还没有发件账号，点右上角「新增账号」' }}
          />
        </Card>
      </Section>

      <Modal
        open={groupModalOpen}
        title="发件分组"
        onCancel={() => setGroupModalOpen(false)}
        footer={null}
        width={520}
      >
        <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 12, lineHeight: 1.7 }}>
          分组的用途是「按业务线选号」：任务里选分组即可，不必逐条挑通道。
          删除分组只解除归属，不会删除账号。
        </div>
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input
            placeholder="新建分组，例如「营销线」"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onPressEnter={() => void createGroup()}
            maxLength={32}
          />
          <Button type="primary" loading={groupBusy} onClick={() => void createGroup()}>
            新建
          </Button>
        </Space.Compact>
        {groups.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.muted, padding: '12px 0' }}>还没有分组</div>
        ) : (
          groups.map((g, i) => (
            <div
              key={g.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
              }}
            >
              <Input
                size="small"
                defaultValue={g.name}
                onBlur={(e) => void renameGroup(g, e.target.value)}
                style={{ flex: 1 }}
                maxLength={32}
              />
              <span style={{ fontSize: 12, color: tokens.muted, width: 72, textAlign: 'right' }}>
                {g.channelCount} 条通道
              </span>
              <Popconfirm
                title={`删除分组「${g.name}」？`}
                description="组内通道会变成未分组，账号本身保留"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void removeGroup(g)}
              >
                <Button size="small" danger type="text" icon={<DeleteOutlined />} />
              </Popconfirm>
            </div>
          ))
        )}
      </Modal>

      <Modal
        title={editing ? `编辑发信身份 · ${editing.name}` : '新增发件账号'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        width={620}
        footer={[
          <Button key="test" icon={<ThunderboltOutlined />} loading={testing === 'new'} onClick={testFromForm}>
            保存前测试连接
          </Button>,
          <Button key="cancel" onClick={() => setFormOpen(false)}>
            取消
          </Button>,
          <Button key="ok" type="primary" loading={saving} onClick={() => form.submit()}>
            保存
          </Button>,
        ]}
      >
        <Form<ChannelForm> form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          {!editing && (
            <Form.Item label="服务商预设" name="preset">
              <Select
                options={presets.map((p) => ({ value: p.key, label: p.label }))}
                onChange={onPresetChange}
                placeholder="选择后自动填充服务器与端口"
              />
            </Form.Item>
          )}

          <Form.Item
            label="通道名称"
            name="name"
            rules={[{ required: true, message: '请起一个能区分用途的名字' }]}
            extra="同一账号可建多条发信身份，仅用于区分用途；配额仍共享"
          >
            <Input placeholder="例如：主力-通知邮件" />
          </Form.Item>

          <Space.Compact style={{ width: '100%' }}>
            <Form.Item
              label="SMTP 服务器"
              name="host"
              style={{ flex: 1, marginRight: 8 }}
              rules={[{ required: true, message: '请填写服务器地址' }]}
            >
              <Input placeholder="smtp.example.com" />
            </Form.Item>
            <Form.Item label="端口" name="port" style={{ width: 110, marginRight: 8 }}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="SSL/TLS" name="secure" valuePropName="checked" style={{ width: 90 }}>
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>
          </Space.Compact>

          <Form.Item
            label="SMTP 用户名"
            name="username"
            rules={[{ required: true, message: '请填写用户名' }]}
            extra="同一服务器 + 用户名会被识别为同一个真实账号，共享配额与发送间隔"
          >
            <Input placeholder="通常是完整邮箱地址" autoComplete="off" />
          </Form.Item>

          <Form.Item
            label={editing ? '密码 / 授权码（留空表示不修改）' : '密码 / 授权码'}
            name="password"
            rules={editing ? [] : [{ required: true, message: '请填写密码或授权码' }]}
            extra="QQ / 163 等必须用授权码，不是登录密码。存库前会用 AES-256-GCM 加密；修改密码会同步到同账号下所有通道"
          >
            <Input.Password placeholder={editing ? '留空则保持原密码' : '授权码'} autoComplete="new-password" />
          </Form.Item>

          <Space.Compact style={{ width: '100%' }}>
            <Form.Item label="发信人名称" name="fromName" style={{ flex: 1, marginRight: 8 }}>
              <Input placeholder="例如：XX 官方团队" />
            </Form.Item>
            <Form.Item
              label="发信地址"
              name="fromEmail"
              style={{ flex: 1 }}
              rules={[{ required: true, type: 'email', message: '请填写合法发信邮箱' }]}
            >
              <Input placeholder="noreply@example.com" />
            </Form.Item>
          </Space.Compact>

          <Form.Item label="回复地址（可选）" name="replyTo" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>

          <Space.Compact style={{ width: '100%' }}>
            <Form.Item
              label="账号每日上限"
              name="dailyLimit"
              style={{ flex: 1, marginRight: 8 }}
              extra="同一账号共享；修改会同步到该账号下所有通道"
            >
              <InputNumber min={1} max={100000} style={{ width: '100%' }} addonAfter="封/天" />
            </Form.Item>
            <Form.Item
              label="账号发送间隔"
              name="minIntervalSec"
              style={{ flex: 1, marginRight: 8 }}
              extra="同一账号两封之间的最小间隔，修改会同步"
            >
              <InputNumber min={1} max={3600} style={{ width: '100%' }} addonAfter="秒" />
            </Form.Item>
            <Form.Item label="发件分组（可多选，任务按分组选号）" name="groupIds">
            <Select
              mode="multiple"
              allowClear
              placeholder="不分组"
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </Form.Item>
          <Form.Item label="优先级" name="priority" style={{ width: 100 }}>
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
        </Form>
      </Modal>

      <Modal
        title="发送测试邮件"
        open={Boolean(testTarget)}
        onCancel={() => setTestTarget(null)}
        onOk={doTestSend}
        okText="发送"
        confirmLoading={testSending}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          将使用通道 <b>{testTarget?.channel.name}</b> 发一封测试信，会消耗该真实账号的 1 封共享配额。
        </Typography.Paragraph>
        <Input
          placeholder="收件地址"
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          addonBefore="收件人"
        />
      </Modal>
    </div>
  );
}
