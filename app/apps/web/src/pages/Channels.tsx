import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
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
  MoreOutlined,
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
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  fromName?: string;
  fromEmail: string;
  replyTo?: string;
  dailyLimit: number;
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
      priority: 0,
    });
    setFormOpen(true);
  };

  const openEdit = (row: ChannelRow) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: '',
      fromName: row.fromName ?? undefined,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo ?? undefined,
      dailyLimit: row.dailyLimit,
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
      const created = await api<{ id: number }>('/channel-groups', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewGroupName('');
      setGroupFilter(created.id);
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
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '重命名失败');
    }
  };

  const removeGroup = async (g: ChannelGroupRow) => {
    try {
      const r = await api<{ ungrouped: number }>(`/channel-groups/${g.id}`, { method: 'DELETE' });
      message.success(r.ungrouped > 0 ? `已删除分组，${r.ungrouped} 个发件邮箱变为未分组` : '已删除分组');
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
            ? `已添加发件邮箱；该 SMTP 账号已有 ${created.accountChannelCount} 个发件邮箱，共用 ${created.accountLimit} 封/天`
            : '已添加发件邮箱',
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
      message.success(`已复制；配额仍与同账号的 ${created.accountChannelCount} 个发件邮箱共享`);
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
      title: '发信邮箱',
      dataIndex: 'fromEmail',
      width: 230,
      render: (v: string, r: ChannelRow) => (
        <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
          <Typography.Text strong ellipsis={{ tooltip: v }}>
            {v}
          </Typography.Text>
          {r.fromName && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: r.fromName }}>
              {r.fromName}
            </Typography.Text>
          )}
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
                与另外 {r.accountChannelCount - 1} 个发件邮箱共享额度
              </span>
            )}
          </Space>
        );
      },
    },
    {
      title: '状态',
      width: 130,
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
      width: 145,
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
      width: 225,
      render: (_: unknown, r: ChannelRow) => (
        <Space size={2}>
          {/* 只有「测试连接」保留文字：它是这一页最常用的动作，
              其余四个都是低频操作，收成图标 + 悬浮说明，列宽才够用 */}
          <Tooltip title="测试连接">
            <Button size="small" type="text" loading={testing === r.id} onClick={() => testRow(r)} icon={<ThunderboltOutlined />} />
          </Tooltip>
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
          <Tooltip title="复制发件邮箱（共享账号配额）">
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => duplicate(r)} />
          </Tooltip>
          <Popconfirm title="确认删除这个发件邮箱？" onConfirm={() => remove(r)} okText="删除" cancelText="取消">
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

  const groupItems = [
    { key: 'all' as const, name: '全部发件邮箱', count: rows.length },
    { key: 'none' as const, name: '未分组', count: rows.filter((r) => r.groupIds.length === 0).length },
  ];
  const activeGroupName =
    groupFilter === 'all'
      ? '全部发件邮箱'
      : groupFilter === 'none'
        ? '未分组'
        : groups.find((g) => g.id === groupFilter)?.name ?? '发件邮箱';

  return (
    <div className="page">
      <PageHeader
        title="发件账号"
        desc={`共 ${rows.length} 个发件邮箱 · ${accountCount} 个真实 SMTP 账号。左侧选分组，任务里按分组选号`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增发件邮箱
          </Button>
        }
      />

      <Row gutter={metrics.gridGutter}>
        <Col span={4}>
          <Section title="分组">
            <Card styles={{ body: { padding: 0 } }}>
              {groupItems.map((item, i) => {
                const active = groupFilter === item.key;
                return (
                  <div
                    key={item.key}
                    onClick={() => setGroupFilter(item.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: metrics.tight,
                      padding: `10px ${metrics.cardPaddingCompact}px`,
                      borderTop: i === 0 ? 'none' : `1px solid ${tokens.border}`,
                      cursor: 'pointer',
                      background: active ? tokens.primarySoft : 'transparent',
                      color: active ? tokens.primary : tokens.foreground,
                      fontWeight: active ? 500 : 400,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                    <span style={{ color: active ? tokens.primary : tokens.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {item.count}
                    </span>
                  </div>
                );
              })}
              {groups.map((g, i) => {
                const active = groupFilter === g.id;
                return (
                  <div
                    key={g.id}
                    onClick={() => setGroupFilter(g.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: metrics.tight,
                      padding: `10px ${metrics.cardPaddingCompact}px`,
                      borderTop: `1px solid ${tokens.border}`,
                      cursor: 'pointer',
                      background: active ? tokens.primarySoft : 'transparent',
                      color: active ? tokens.primary : tokens.foreground,
                      fontWeight: active ? 500 : 400,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {g.name}
                    </span>
                    <span style={{ color: active ? tokens.primary : tokens.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {g.channelCount}
                    </span>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'rename', label: '重命名', icon: <EditOutlined /> },
                          { key: 'delete', label: '删除分组', icon: <DeleteOutlined />, danger: true },
                        ],
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation();
                          if (key === 'rename') {
                            let newName = g.name;
                            modal.confirm({
                              title: '重命名分组',
                              content: (
                                <Input
                                  defaultValue={g.name}
                                  maxLength={32}
                                  onChange={(e) => {
                                    newName = e.target.value;
                                  }}
                                />
                              ),
                              onOk: () => renameGroup(g, newName),
                            });
                          } else {
                            void removeGroup(g);
                          }
                        },
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        icon={<MoreOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Dropdown>
                  </div>
                );
              })}
              <div style={{ padding: `10px ${metrics.cardPaddingCompact}px`, borderTop: `1px solid ${tokens.border}` }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    size="small"
                    placeholder="新建分组"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onPressEnter={() => void createGroup()}
                    maxLength={32}
                  />
                  <Button size="small" loading={groupBusy} onClick={() => void createGroup()}>
                    添加
                  </Button>
                </Space.Compact>
              </div>
            </Card>
          </Section>
        </Col>

        <Col span={20}>
          <Section
            title={activeGroupName}
            desc={`配额按真实 SMTP 账号计算：同一个账号下的多个发件邮箱共用一本每日额度。发送节奏由任务里的间隔设置决定，这里不再单独配置。`}
            style={{ height: '100%' }}
          >
            <Card className="card-table" style={{ height: '100%' }}>
              <Table<ChannelRow>
                rowKey="id"
                loading={loading}
                dataSource={shownRows}
                columns={columns as any}
                scroll={{ x: 930 }}
                tableLayout="fixed"
                pagination={false}
                locale={{ emptyText: '还没有发件邮箱，点右上角「新增发件邮箱」' }}
              />
            </Card>
          </Section>
        </Col>
      </Row>

      <Modal
        title={editing ? `编辑发件邮箱 · ${editing.fromEmail}` : '新增发件邮箱'}
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
            extra="同一服务器 + 用户名会被识别为同一个真实账号，共享每日配额"
          >
            <Input placeholder="通常是完整邮箱地址" autoComplete="off" />
          </Form.Item>

          <Form.Item
            label={editing ? '密码 / 授权码（留空表示不修改）' : '密码 / 授权码'}
            name="password"
            rules={editing ? [] : [{ required: true, message: '请填写密码或授权码' }]}
            extra="QQ / 163 等必须用授权码，不是登录密码。存库前会加密存储；修改密码会同步到同账号下所有发件邮箱"
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
              extra="同一账号共享；修改会同步到该账号下所有发件邮箱"
            >
              <InputNumber min={1} max={100000} style={{ width: '100%' }} addonAfter="封/天" />
            </Form.Item>
            <Form.Item label="发件分组（可多选，任务按分组选号）" name="groupIds" style={{ flex: 1 }}>
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
          将使用 <b>{testTarget?.channel.fromEmail}</b> 发一封测试信，会消耗该真实账号的 1 封共享配额。
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
