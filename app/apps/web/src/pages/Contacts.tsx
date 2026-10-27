import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Col,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  ImportOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import ImportWizard from './ImportWizard';
import { metrics, tokens } from '../theme';

/** 来源是后端枚举，界面上不该出现 manual / import 这种原始值 */
const SOURCE_LABEL: Record<string, string> = {
  manual: '手工添加',
  import: '文件导入',
  api: '接口写入',
  form: '表单提交',
  list: '分组导入',
};

interface ListRow {
  id: number;
  name: string;
  description: string | null;
  contactCount: number;
}

interface ContactRow {
  id: number;
  email: string;
  name: string | null;
  source: string | null;
  createdAt: string;
  lists: { id: number; name: string }[];
}

export default function Contacts() {
  const { message, modal } = AntApp.useApp();

  const [lists, setLists] = useState<ListRow[]>([]);
  const [listId, setListId] = useState<number | null>(null);
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [listTarget, setListTarget] = useState<ContactRow | null>(null);
  const [selectedListIds, setSelectedListIds] = useState<number[]>([]);
  const [savingLists, setSavingLists] = useState(false);
  const [listModal, setListModal] = useState<{ open: boolean; editing: ListRow | null }>({
    open: false,
    editing: null,
  });
  const [form] = Form.useForm();

  const loadLists = useCallback(async () => {
    try {
      const data = await api<ListRow[]>('/lists');
      setLists(data);
    } catch {
      // 列表加载失败不打断主流程
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api<Record<string, number>>('/contacts/stats'));
    } catch {
      // ignore
    }
  }, []);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (keyword.trim()) qs.set('q', keyword.trim());
      if (status) qs.set('status', status);
      if (listId) qs.set('listId', String(listId));

      const r = await api<{ items: ContactRow[]; total: number }>(`/contacts?${qs.toString()}`);
      setRows(r.items);
      setTotal(r.total);
    } catch (e: any) {
      message.error(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, status, listId, message]);

  useEffect(() => {
    void loadLists();
    void loadStats();
  }, [loadLists, loadStats]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const reloadAll = () => {
    void loadLists();
    void loadStats();
    void loadContacts();
  };

  const saveList = async (values: { name: string; description?: string }) => {
    try {
      if (listModal.editing) {
        await api(`/lists/${listModal.editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(values),
        });
        message.success('已保存');
      } else {
        await api('/lists', { method: 'POST', body: JSON.stringify(values) });
        message.success('已创建分组');
      }
      setListModal({ open: false, editing: null });
      form.resetFields();
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '保存失败');
    }
  };

  const removeList = async (l: ListRow) => {
    try {
      await api(`/lists/${l.id}`, { method: 'DELETE' });
      message.success('已删除分组（联系人本身保留）');
      if (listId === l.id) setListId(null);
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '删除失败');
    }
  };

  const addContact = async (values: { email: string; name?: string }) => {
    try {
      await api('/contacts', {
        method: 'POST',
        body: JSON.stringify({ ...values, listId: listId ?? undefined }),
      });
      message.success('已添加');
      setAddOpen(false);
      form.resetFields();
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '添加失败');
    }
  };

  const setContactStatus = async (row: ContactRow, next: string) => {
    try {
      await api(`/contacts/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      message.success('已更新');
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '更新失败');
    }
  };

  const removeContact = async (row: ContactRow) => {
    try {
      await api(`/contacts/${row.id}`, { method: 'DELETE' });
      message.success('已删除');
      reloadAll();
    } catch (e: any) {
      modal.warning({ title: '无法删除', content: e?.message ?? '未知错误' });
    }
  };

  const openContactLists = (row: ContactRow) => {
    setListTarget(row);
    setSelectedListIds(row.lists.map((l) => l.id));
  };

  const saveContactLists = async () => {
    if (!listTarget) return;
    setSavingLists(true);
    try {
      await api(`/contacts/${listTarget.id}/lists`, {
        method: 'PUT',
        body: JSON.stringify({ listIds: selectedListIds }),
      });
      message.success('分组已更新');
      setListTarget(null);
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '保存分组失败');
    } finally {
      setSavingLists(false);
    }
  };

  const columns = [
    {
      title: '邮箱',
      dataIndex: 'email',
      width: 260,
      ellipsis: true,
      render: (v: string) => (
        <span className="mono" style={{ display: 'block' }} title={v}>
          {v}
        </span>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'name',
      width: 150,
      render: (v: string | null) => v || <span style={{ color: tokens.muted }}>—</span>,
    },
    {
      title: '分组',
      width: 190,
      render: (_: unknown, r: ContactRow) => {
        // 只展示第一个分组 + 其余数量：全部铺开会把行高撑成两行，
        // 长列表里一眼扫不到人。完整归属放进悬浮提示。
        if (r.lists.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
        const extra = r.lists.slice(1);
        return (
          <Space size={4}>
            <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
              {r.lists[0].name}
            </Tag>
            {extra.length > 0 && (
              <Tooltip title={extra.map((l) => l.name).join('、')}>
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  +{extra.length}
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 150,
      ellipsis: true,
      render: (v: string | null) =>
        v ? (
          <span style={{ fontSize: 12, color: tokens.muted }}>{SOURCE_LABEL[v] ?? v}</span>
        ) : (
          <span style={{ color: tokens.muted }}>—</span>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 130,
      render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      width: 240,
      render: (_: unknown, r: ContactRow) => (
        <Space size={4}>
          <Button size="small" icon={<FolderOutlined />} onClick={() => openContactLists(r)}>
            分组
          </Button>
          <Popconfirm
            title="确认删除该联系人？"
            description="有投递历史的联系人无法删除；只是不想再发给他，可以把他移出所有分组"
            okText="删除"
            cancelText="取消"
            onConfirm={() => removeContact(r)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="联系人"
        desc={`共 ${stats.total ?? 0} 人 · 抑制 ${stats.suppressed ?? 0}；抑制名单里的地址任何任务都不会发送`}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={reloadAll} />
            <Button
              icon={<UserAddOutlined />}
              onClick={() => {
                setAddOpen(true);
                form.resetFields();
              }}
            >
              新增
            </Button>
            <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              导入文件
            </Button>
          </>
        }
      />

      <Row gutter={metrics.gridGutter}>
        <Col span={4}>
          <Section
            title="分组"
            extra={
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onClick={() => {
                  setListModal({ open: true, editing: null });
                  form.resetFields();
                }}
              />
            }
          >
            <Card styles={{ body: { padding: 0 } }}>
              {[
                { id: null as number | null, name: '全部联系人', count: stats.total ?? 0 },
                ...lists.map((l) => ({ id: l.id as number | null, name: l.name, count: l.contactCount })),
              ].map((item, i) => {
                const active = listId === item.id;
                return (
                  <div
                    key={item.id ?? 'all'}
                    onClick={() => {
                      setListId(item.id);
                      setPage(1);
                    }}
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
                    {item.id !== null && (
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            { key: 'rename', label: '重命名', icon: <EditOutlined /> },
                            { key: 'delete', label: '删除分组', icon: <DeleteOutlined />, danger: true },
                          ],
                          onClick: ({ key, domEvent }) => {
                            domEvent.stopPropagation();
                            const row = lists.find((l) => l.id === item.id);
                            if (!row) return;
                            if (key === 'rename') setListModal({ open: true, editing: row });
                            else void removeList(row);
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
                    )}
                  </div>
                );
              })}
            </Card>
          </Section>
        </Col>

        <Col span={20}>
          <Section
            title={listId ? lists.find((l) => l.id === listId)?.name ?? '联系人' : '全部联系人'}
            desc="按分组圈定发信范围；一个联系人可以同时属于多个分组"
            style={{ height: '100%' }}
          >
            <Card className="card-table" style={{ height: '100%' }}>
              <div className="table-toolbar">
                <Input.Search
                  allowClear
                  placeholder="搜索邮箱或姓名"
                  style={{ width: 280 }}
                  onSearch={(v) => {
                    setKeyword(v);
                    setPage(1);
                  }}
                />
                <span style={{ fontSize: 12, color: tokens.muted }}>共 {total} 条</span>
              </div>

              <Table<ContactRow>
                rowKey="id"
                loading={loading}
                dataSource={rows}
                columns={columns as any}
                scroll={{ x: 1210 }}
                tableLayout="fixed"
                pagination={{
                  current: page,
                  pageSize,
                  total,
                  showSizeChanger: true,
                  showTotal: (t2) => `共 ${t2} 条`,
                  onChange: (p2, ps) => {
                    setPage(p2);
                    setPageSize(ps);
                  },
                }}
                locale={{ emptyText: '还没有联系人，点右上角「导入文件」' }}
              />
            </Card>
          </Section>
        </Col>
      </Row>

      <ImportWizard
        open={importOpen}
        lists={lists}
        defaultListId={listId}
        onClose={() => setImportOpen(false)}
        onDone={reloadAll}
      />

      <Modal
        title={listModal.editing ? '重命名分组' : '新建分组'}
        open={listModal.open}
        onCancel={() => setListModal({ open: false, editing: null })}
        onOk={() => form.submit()}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={saveList} requiredMark={false}>
          <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请填写名称' }]}>
            <Input placeholder="例如：老客户-2026Q4" />
          </Form.Item>
          <Form.Item name="description" label="备注（可选）">
            <Input placeholder="这份名单的来源、用途" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新增联系人"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => form.submit()}
        okText="添加"
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={addContact} requiredMark={false}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请填写邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input placeholder="someone@example.com" />
          </Form.Item>
          <Form.Item name="name" label="姓名（可选）">
            <Input placeholder="张三" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="管理分组"
        open={Boolean(listTarget)}
        onCancel={() => setListTarget(null)}
        onOk={saveContactLists}
        okText="保存"
        confirmLoading={savingLists}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          联系人：<span className="mono">{listTarget?.email}</span>
          <br />
          勾选表示加入分组，取消勾选会把该联系人移出对应分组。联系人本身不会被删除。
        </Typography.Paragraph>
        {lists.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分组，请先在左侧新建" />
        ) : (
          <Checkbox.Group
            value={selectedListIds}
            onChange={(vals) => setSelectedListIds(vals as number[])}
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            options={lists.map((l) => ({
              label: `${l.name}（${l.contactCount} 人）`,
              value: l.id,
            }))}
          />
        )}
      </Modal>
    </div>
  );
}
