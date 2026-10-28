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
        await api<ChannelRow>('/channels', { method: 'POST', body: JSON.stringify(body) });
        message.success('已添加发件邮箱');
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
      await api<ChannelRow>(`/channels/${row.id}/duplicate`, { method: 'POST' });
      message.success('已复制为一个新的发件邮箱');
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
      title: '今日配额',
      width: 170,
      render: (_: unknown, r: ChannelRow) => (
        // 只给数字：条的长度取决于上限，读者无法据此比较两个邮箱，纯属噪音
        <div style={{ display: 'flex', gap: 8, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: tokens.ink }}>
            {r.sentToday} / {r.dailyLimit}
          </span>
          <span style={{ color: r.remaining === 0 ? tokens.destructive : tokens.muted }}>剩 {r.remaining}</span>
        </div>
      ),
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
        desc={`共 ${rows.length} 个发件邮箱`}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增发件邮箱
          </Button>
        }
      />

      <Row gutter={metrics.gridGutter}>
        <Col span={5}>
          <Section title="分组" style={{ height: '100%' }}>
            <Card
              style={{ overflow: 'hidden' }}
              styles={{ body: { padding: 0, height: '100%', overflow: 'auto' } }}
            >
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

        <Col span={19}>
          <Section
            title={activeGroupName}
            style={{ height: '100%' }}
          >
            <Card className="card-table" style={{ height: '100%' }}>
              <Table<ChannelRow>
                rowKey="id"
                loading={loading}
                dataSource={shownRows}
                columns={columns as any}
                scroll={{ x: 900 }}
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
        width={640}
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
                placeholder="选择服务商"
              />
            </Form.Item>
          )}

          <Row gutter={metrics.gridGutter}>
            <Col span={16}>
              <Form.Item
                label="SMTP 服务器"
                name="host"
                rules={[{ required: true, message: '请填写服务器地址' }]}
              >
                <Input placeholder="smtp.example.com" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="端口" name="port">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="SSL/TLS" name="secure" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={metrics.gridGutter}>
            <Col span={12}>
              <Form.Item
                label="SMTP 用户名"
                name="username"
                rules={[{ required: true, message: '请填写用户名' }]}
              >
                <Input placeholder="通常是完整邮箱地址" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="密码 / 授权码"
                name="password"
                rules={editing ? [] : [{ required: true, message: '请填写密码或授权码' }]}
              >
                <Input.Password
                  placeholder={editing ? '留空则不修改' : '授权码'}
                  autoComplete="new-password"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={metrics.gridGutter}>
            <Col span={12}>
              <Form.Item label="发信人名称" name="fromName">
                <Input placeholder="Mailer" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="发信地址"
                name="fromEmail"
                rules={[{ required: true, type: 'email', message: '请填写合法发信邮箱' }]}
              >
                <Input placeholder="noreply@example.com" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="回复地址" name="replyTo" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>

          <Row gutter={metrics.gridGutter}>
            <Col span={12}>
              <Form.Item label="每日上限" name="dailyLimit">
                <InputNumber min={1} max={100000} style={{ width: '100%' }} addonAfter="封/天" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="优先级" name="priority">
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="发件分组" name="groupIds" style={{ marginBottom: 0 }}>
            <Select
              mode="multiple"
              allowClear
              placeholder="不分组"
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </Form.Item>
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
