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
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  ImportOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import Section from '../components/Section';
import PageHeader from '../components/PageHeader';
import ImportWizard from './ImportWizard';
import { metrics, tokens } from '../theme';

interface ListRow {
  id: number;
  name: string;
  description: string | null;
  /** 系统内置分组（地址不存在）有固定标识，不能删除 */
  systemKey: string | null;
  contactCount: number;
}

interface ContactRow {
  id: number;
  email: string;
  name: string | null;
  /** 自定义字段，编辑弹窗里以键值对形式展示 */
  fields: Record<string, string> | null;
  source: string | null;
  createdAt: string;
  lists: { id: number; name: string }[];
  /** 硬退信被拉黑，任何任务都不会再发到这个地址 */
  undeliverable: boolean;
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
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchListOpen, setBatchListOpen] = useState(false);
  const [batchListIds, setBatchListIds] = useState<number[]>([]);
  const [batchReplace, setBatchReplace] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** 非空表示"编辑"，为空表示"新增"——两个场景共用同一个弹窗 */
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [fieldPairs, setFieldPairs] = useState<{key: string; value: string}[]>([]);
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
      if (listId) qs.set('listId', String(listId));

      const r = await api<{ items: ContactRow[]; total: number }>(`/contacts?${qs.toString()}`);
      setRows(r.items);
      setTotal(r.total);
    } catch (e: any) {
      message.error(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, listId, message]);

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

  /**
   * 删除分组 / 清空分组都会真的删掉组内联系人（投递记录一起清空），
   * 所以必须二次确认，并把"会删多少人"写在弹窗里，不能只写"不可恢复"。
   */
  const confirmDeleteMembers = (l: ListRow, mode: 'delete' | 'clear') => {
    const count = l.contactCount;
    modal.confirm({
      title: mode === 'delete' ? `删除分组「${l.name}」？` : `清空分组「${l.name}」？`,
      content:
        count > 0
          ? `组内 ${count} 个联系人会被一并删除，他们的投递记录同时清空，无法恢复。`
          : '这个分组是空的，操作不可恢复。',
      okText: mode === 'delete' ? '删除' : '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r =
            mode === 'delete'
              ? await api<{ deletedContacts: number }>(`/lists/${l.id}`, { method: 'DELETE' })
              : await api<{ deletedContacts: number }>(`/lists/${l.id}/clear`, { method: 'POST' });
          message.success(
            mode === 'delete'
              ? `已删除分组${r.deletedContacts > 0 ? `，连同 ${r.deletedContacts} 个联系人` : ''}`
              : `已清空${r.deletedContacts > 0 ? `，删除 ${r.deletedContacts} 个联系人` : ''}`,
          );
          if (mode === 'delete' && listId === l.id) setListId(null);
          setSelectedIds([]);
          reloadAll();
        } catch (e: any) {
          message.error(e?.message ?? '操作失败');
        }
      },
    });
  };

  const collectFields = () => {
    const out: Record<string, string> = {};
    for (const p of fieldPairs) {
      const key = p.key.trim();
      if (key) out[key] = p.value.trim();
    }
    return out;
  };

  const openEdit = (row: ContactRow) => {
    setEditing(row);
    form.setFieldsValue({ email: row.email, name: row.name ?? '' });
    setFieldPairs(
      Object.entries(row.fields ?? {}).map(([key, value]) => ({ key, value: String(value ?? '') })),
    );
    setAddOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ listId: listId ?? undefined });
    setFieldPairs([]);
    setAddOpen(true);
  };

  const submitContact = async (values: { email: string; name?: string }) => {
    const fields = collectFields();
    try {
      if (editing) {
        await api(`/contacts/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: values.email, name: values.name ?? '', fields }),
        });
        message.success('已保存');
      } else {
        await api('/contacts', {
          method: 'POST',
          body: JSON.stringify({ ...values, fields, listId: listId ?? undefined }),
        });
        message.success('已添加');
      }
      setAddOpen(false);
      setEditing(null);
      form.resetFields();
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? (editing ? '保存失败' : '添加失败'));
    }
  };

  const removeContact = (row: ContactRow) => {
    modal.confirm({
      title: '删除这个联系人？',
      content: `${row.email} 会被移出所有分组，投递历史保留但不再发送。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api(`/contacts/${row.id}`, { method: 'DELETE' });
          message.success('已删除');
          setSelectedIds((prev) => prev.filter((id) => id !== row.id));
          reloadAll();
        } catch (e: any) {
          message.error(e?.message ?? '删除失败');
        }
      },
    });
  };

  const removeSelected = () => {
    if (selectedIds.length === 0) return;
    modal.confirm({
      title: `删除选中的 ${selectedIds.length} 个联系人？`,
      content: '会同时删掉这些人的投递记录，无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api<{ deleted: number }>('/contacts/batch-delete', {
            method: 'POST',
            body: JSON.stringify({ ids: selectedIds }),
          });
          message.success(`已删除 ${r.deleted} 个联系人`);
          setSelectedIds([]);
          reloadAll();
        } catch (e: any) {
          message.error(e?.message ?? '删除失败');
        }
      },
    });
  };

  /** 勾选多人后统一改分组：默认追加，打开「替换」则先清空原有分组 */
  const openBatchLists = () => {
    setBatchListIds([]);
    setBatchReplace(false);
    setBatchListOpen(true);
  };

  const submitBatchLists = async () => {
    setBatchSaving(true);
    try {
      const r = await api<{ updated: number }>('/contacts/batch-lists', {
        method: 'POST',
        body: JSON.stringify({
          ids: selectedIds,
          listIds: batchListIds,
          replace: batchReplace,
        }),
      });
      message.success(`已调整 ${r.updated} 个联系人的分组`);
      setBatchListOpen(false);
      setSelectedIds([]);
      reloadAll();
    } catch (e: any) {
      message.error(e?.message ?? '调整失败');
    } finally {
      setBatchSaving(false);
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
      width: 280,
      ellipsis: true,
      render: (v: string, r: ContactRow) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            className="mono"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={v}
          >
            {v}
          </span>
          {r.undeliverable && (
            <Tag
              bordered={false}
              style={{
                marginInlineEnd: 0,
                flexShrink: 0,
                fontSize: 11,
                background: tokens.destructiveSoft,
                color: tokens.destructiveDeep,
              }}
            >
              地址不存在
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'name',
      width: 130,
      render: (v: string | null) => v || <span style={{ color: tokens.muted }}>—</span>,
    },
    {
      title: '分组',
      width: 170,
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
      title: '操作',
      width: 120,
      align: 'right' as const,
      // 窄屏时表格要横向滚动，操作列固定在右侧，不至于被滚出视野
      fixed: 'right' as const,
      render: (_: unknown, r: ContactRow) => (
        <Space size={2}>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Tooltip title="调整分组">
            <Button size="small" type="text" icon={<FolderOutlined />} onClick={() => openContactLists(r)} />
          </Tooltip>
          <Tooltip title="删除">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeContact(r)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  // 系统分组（地址不存在）置顶：它是需要经常处理的异常名单，不该埋在一堆分组里
  const sidebarItems = [
    { id: null as number | null, name: '全部联系人', count: stats.total ?? 0, systemKey: null as string | null },
    ...lists
      .slice()
      .sort((a, b) => (a.systemKey ? 0 : 1) - (b.systemKey ? 0 : 1) || a.id - b.id)
      .map((l) => ({
        id: l.id as number | null,
        name: l.name,
        count: l.contactCount,
        systemKey: l.systemKey,
      })),
  ];

  return (
    <div className="page">
      <PageHeader
        title="联系人"
        desc={`共 ${stats.total ?? 0} 人 · ${stats.undeliverable ?? 0} 个地址不存在`}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={reloadAll} />
            <Button
              icon={<UserAddOutlined />}
              onClick={openCreate}
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
        <Col span={5}>
          <Section
            title="分组"
            style={{ height: '100%' }}
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
            <Card
              style={{ overflow: 'hidden' }}
              styles={{ body: { padding: 0, height: '100%', overflow: 'auto' } }}
            >
              {sidebarItems.map((item, i) => {
                const active = listId === item.id;
                return (
                  <div
                    key={item.id ?? 'all'}
                    onClick={() => {
                      setListId(item.id);
                      setPage(1);
                      setSelectedIds([]);
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
                    <span
                      style={{
                        color: active
                          ? tokens.primary
                          : item.systemKey && item.count > 0
                            ? tokens.destructive
                            : tokens.muted,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {item.count}
                    </span>
                    {item.id !== null && (
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            { key: 'rename', label: '重命名', icon: <EditOutlined /> },
                            { key: 'clear', label: '清空分组', icon: <ClearOutlined />, danger: true },
                            // 系统分组是退信的落点，删掉就无处归置；只能清空，不能删除
                            ...(item.systemKey
                              ? []
                              : [{ key: 'delete', label: '删除分组', icon: <DeleteOutlined />, danger: true }]),
                          ],
                          onClick: ({ key, domEvent }) => {
                            domEvent.stopPropagation();
                            const row = lists.find((l) => l.id === item.id);
                            if (!row) return;
                            if (key === 'rename') setListModal({ open: true, editing: row });
                            else if (key === 'clear') confirmDeleteMembers(row, 'clear');
                            else confirmDeleteMembers(row, 'delete');
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

        <Col span={19}>
          <Section
            title={listId ? lists.find((l) => l.id === listId)?.name ?? '联系人' : '全部联系人'}
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
                    setSelectedIds([]);
                  }}
                />
                {selectedIds.length > 0 ? (
                  <Space size={8}>
                    <span style={{ fontSize: 12, color: tokens.muted }}>已选 {selectedIds.length} 个</span>
                    <Button size="small" icon={<FolderOutlined />} onClick={openBatchLists}>
                      调整分组
                    </Button>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={removeSelected}>
                      删除选中
                    </Button>
                  </Space>
                ) : (
                  <span style={{ fontSize: 12, color: tokens.muted }}>共 {total} 条</span>
                )}
              </div>

              <Table<ContactRow>
                rowKey="id"
                loading={loading}
                dataSource={rows}
                columns={columns as any}
                rowSelection={{
                  selectedRowKeys: selectedIds,
                  onChange: (keys) => setSelectedIds(keys as number[]),
                }}
                scroll={{ x: 760 }}
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
                    setSelectedIds([]);
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
        </Form>
      </Modal>

      <Modal
        title={editing ? '编辑联系人' : '新增联系人'}
        open={addOpen}
        onCancel={() => {
          setAddOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        okText={editing ? '保存' : '添加'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={submitContact} requiredMark={false}>
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
          <Form.Item name="name" label="姓名">
            <Input placeholder="张三" />
          </Form.Item>

          <div style={{ fontSize: 13, color: tokens.ink, marginBottom: 8 }}>自定义字段</div>
          {fieldPairs.map((pair, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <Input
                placeholder="字段名"
                style={{ width: 140 }}
                value={pair.key}
                onChange={(e) => {
                  const next = [...fieldPairs];
                  next[i] = { ...next[i], key: e.target.value };
                  setFieldPairs(next);
                }}
              />
              <Input
                placeholder="值"
                value={pair.value}
                onChange={(e) => {
                  const next = [...fieldPairs];
                  next[i] = { ...next[i], value: e.target.value };
                  setFieldPairs(next);
                }}
              />
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => setFieldPairs(fieldPairs.filter((_, idx) => idx !== i))}
              />
            </div>
          ))}
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            onClick={() => setFieldPairs([...fieldPairs, { key: '', value: '' }])}
          >
            添加字段
          </Button>
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

      <Modal
        title={`调整分组（${selectedIds.length} 个联系人）`}
        open={batchListOpen}
        onCancel={() => setBatchListOpen(false)}
        onOk={submitBatchLists}
        okText="保存"
        cancelText="取消"
        confirmLoading={batchSaving}
        okButtonProps={{ disabled: batchListIds.length === 0 && !batchReplace }}
        destroyOnClose
      >
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label="分组">
            <Select
              mode="multiple"
              allowClear
              placeholder="选择分组"
              value={batchListIds}
              onChange={(v) => setBatchListIds(v as number[])}
              options={lists.map((l) => ({ value: l.id, label: l.name }))}
            />
          </Form.Item>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 4,
            }}
          >
            <span style={{ fontSize: 13, color: tokens.foreground }}>替换原有分组</span>
            <Switch size="small" checked={batchReplace} onChange={setBatchReplace} />
          </div>
        </Form>
      </Modal>
    </div>
  );
}
