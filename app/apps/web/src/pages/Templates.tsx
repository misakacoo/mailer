import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, upload } from '../api';
import PageHeader from '../components/PageHeader';
import Section from '../components/Section';
import { tokens } from '../theme';
import RichEditor, { RichEditorHandle } from '../components/RichEditor';

interface TemplateRow {
  id: number;
  name: string;
  subject: string;
  trackOpen: boolean;
  trackClick: boolean;
  attachmentCount: number;
  updatedAt: string;
  deletedAt: string | null;
}

interface TemplateDetail extends TemplateRow {
  html: string;
  text: string | null;
  attachmentIds: number[];
  variables: string[];
}

interface AttachmentRow {
  id: number;
  filename: string;
  size: number;
  mime: string;
}

interface ChannelRow {
  id: number;
  name: string;
  fromEmail: string;
  remaining: number;
  status: string;
}

interface Draft {
  id: number | null;
  name: string;
  subject: string;
  html: string;
  text: string;
  trackOpen: boolean;
  trackClick: boolean;
  attachmentIds: number[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  subject: '',
  html: '<p>你好 {{name}}，</p><p>这里是正文。</p><p>—— {{year}}</p>',
  text: '',
  trackOpen: true,
  trackClick: true,
  attachmentIds: [],
};

const SAMPLE_VARS = ['{{name}}', '{{email}}', '{{date}}', '{{year}}'];

export default function Templates() {
  const { message, modal } = AntApp.useApp();

  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [mode, setMode] = useState<'rich' | 'html'>('rich');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; html: string; text: string; missing: string[] } | null>(
    null,
  );
  const [testOpen, setTestOpen] = useState(false);
  const [testForm] = Form.useForm<{ channelId: number; to: string }>();
  const [testing, setTesting] = useState(false);

  const editorRef = useRef<RichEditorHandle>(null);
  const htmlAreaRef = useRef<HTMLTextAreaElement>(null);

  const [recycleBin, setRecycleBin] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, ch] = await Promise.all([
        api<TemplateRow[]>(`/templates${recycleBin ? '?deleted=1' : ''}`),
        api<ChannelRow[]>('/channels'),
      ]);
      setRows(t);
      setChannels(ch);
    } catch (e: any) {
      message.error(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message, recycleBin]);

  const loadAttachments = useCallback(async () => {
    try {
      setAttachments(await api<AttachmentRow[]>('/templates/attachments'));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAttachments();
  }, [load, loadAttachments]);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setMode('rich');
    setOpen(true);
  };

  const openEdit = async (row: TemplateRow) => {
    try {
      const d = await api<TemplateDetail>(`/templates/${row.id}`);
      setDraft({
        id: d.id,
        name: d.name,
        subject: d.subject,
        html: d.html,
        text: d.text ?? '',
        trackOpen: d.trackOpen,
        trackClick: d.trackClick,
        attachmentIds: d.attachmentIds ?? [],
      });
      setMode('rich');
      setOpen(true);
    } catch (e: any) {
      message.error(e?.message ?? '加载模板失败');
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      message.warning('请填写模板名称');
      return false;
    }
    if (!draft.subject.trim()) {
      message.warning('请填写邮件主题');
      return false;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        subject: draft.subject.trim(),
        html: draft.html,
        text: draft.text.trim() || null,
        trackOpen: draft.trackOpen,
        trackClick: draft.trackClick,
        attachmentIds: draft.attachmentIds,
      };
      if (draft.id) {
        await api(`/templates/${draft.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        message.success('已保存');
      } else {
        const r = await api<{ id: number }>('/templates', { method: 'POST', body: JSON.stringify(body) });
        setDraft((d) => ({ ...d, id: r.id }));
        message.success('已创建');
      }
      await load();
      return true;
    } catch (e: any) {
      message.error(e?.message ?? '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const doPreview = async () => {
    try {
      const r = await api<{ subject: string; html: string; text: string; missingVariables: string[] }>(
        '/templates/preview',
        {
          method: 'POST',
          body: JSON.stringify({
            subject: draft.subject,
            html: draft.html,
            text: draft.text || undefined,
            trackOpen: draft.trackOpen,
            trackClick: draft.trackClick,
            sample: { email: 'sample@example.com', name: '示例联系人', fields: {} },
          }),
        },
      );
      setPreview({ subject: r.subject, html: r.html, text: r.text, missing: r.missingVariables });
    } catch (e: any) {
      message.error(e?.message ?? '预览失败');
    }
  };

  const openTest = async () => {
    if (!draft.id) {
      message.warning('请先保存模板，再发送测试邮件');
      return;
    }
    const ok = await save();
    if (!ok) return;
    testForm.setFieldsValue({
      channelId: channels[0]?.id,
      to: channels[0]?.fromEmail ?? '',
    });
    setTestOpen(true);
  };

  const doTestSend = async (v: { channelId: number; to: string }) => {
    if (!draft.id) return;
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; message: string; renderedSubject?: string }>(
        `/templates/${draft.id}/test-send`,
        { method: 'POST', body: JSON.stringify({ channelId: v.channelId, to: v.to }) },
      );
      if (r.ok) {
        message.success(r.message);
        setTestOpen(false);
        await load();
      } else {
        message.error(r.message);
      }
    } catch (e: any) {
      message.error(e?.message ?? '发送失败');
    } finally {
      setTesting(false);
    }
  };

  /** 删除进回收站；确认框说明后果，而不是只问一句"确定吗" */
  const remove = (row: TemplateRow) => {
    modal.confirm({
      title: `把模板「${row.name}」移入回收站？`,
      content: '正在编辑的任务仍能保存，但新建任务将选不到它。可以从回收站恢复。',
      okText: '移入回收站',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api(`/templates/${row.id}`, { method: 'DELETE' });
          message.success('已移入回收站');
          await load();
        } catch (e: any) {
          message.error(e?.message ?? '删除失败');
        }
      },
    });
  };

  const restore = async (row: TemplateRow) => {
    try {
      await api(`/templates/${row.id}/restore`, { method: 'POST' });
      message.success('已从回收站恢复');
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '恢复失败');
    }
  };

  const purge = (row: TemplateRow) => {
    modal.confirm({
      title: `彻底删除「${row.name}」？`,
      content: '模板正文与配置将永久删除，无法恢复。仍被任务引用的模板会拒绝彻底删除。',
      okText: '彻底删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api(`/templates/${row.id}/purge`, { method: 'POST' });
          message.success('已彻底删除');
          await load();
        } catch (e: any) {
          message.error(e?.message ?? '彻底删除失败');
        }
      },
    });
  };

  const duplicate = async (row: TemplateRow) => {
    try {
      await api(`/templates/${row.id}/duplicate`, { method: 'POST' });
      message.success('已复制');
      await load();
    } catch (e: any) {
      message.error(e?.message ?? '复制失败');
    }
  };

  const insertVar = (token: string) => {
    if (mode === 'rich') {
      editorRef.current?.insert(token);
      setDraft((d) => ({ ...d, html: d.html }));
      return;
    }
    const area = htmlAreaRef.current;
    if (!area) {
      setDraft((d) => ({ ...d, html: d.html + token }));
      return;
    }
    const start = area.selectionStart ?? draft.html.length;
    const end = area.selectionEnd ?? draft.html.length;
    const next = draft.html.slice(0, start) + token + draft.html.slice(end);
    setDraft((d) => ({ ...d, html: next }));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const doUpload = async (file: File) => {
    try {
      const r = await upload<{ id: number }>('/templates/attachments', file);
      setDraft((d) => ({ ...d, attachmentIds: [...d.attachmentIds, r.id] }));
      await loadAttachments();
      message.success('附件已上传');
    } catch (e: any) {
      message.error(e?.message ?? '上传失败');
    }
  };

  const columns = [
    { title: '模板名称', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
    {
      title: '主题',
      dataIndex: 'subject',
      ellipsis: true,
      render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text>,
    },
    {
      title: '追踪',
      width: 140,
      render: (_: unknown, r: TemplateRow) => (
        <Space size={4}>
          {r.trackOpen && <Tag bordered={false}>打开</Tag>}
          {r.trackClick && <Tag bordered={false}>点击</Tag>}
          {!r.trackOpen && !r.trackClick && <Typography.Text type="secondary">关闭</Typography.Text>}
        </Space>
      ),
    },
    {
      title: '附件',
      dataIndex: 'attachmentCount',
      width: 80,
      render: (v: number) =>
        v > 0 ? (
          <Tag bordered={false} icon={<PaperClipOutlined />} style={{ marginInlineEnd: 0 }}>
            {v}
          </Tag>
        ) : (
          <span style={{ color: tokens.muted }}>—</span>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 130,
      render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      width: 140,
      render: (_: unknown, r: TemplateRow) => {
        // 回收站里只给「恢复」和「彻底删除」两个动作
        if (r.deletedAt) {
          return (
            <Space size={2}>
              <Tooltip title="恢复到模板列表">
                <Button size="small" type="text" icon={<UndoOutlined />} onClick={() => void restore(r)} />
              </Tooltip>
              <Popconfirm title="彻底删除后无法恢复，确认？" okText="彻底删除" cancelText="取消" onConfirm={() => purge(r)}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          );
        }
        // 与其他页面一致：表格里的动作一律无描边图标 + 悬浮说明
        return (
          <Space size={2}>
            <Tooltip title="编辑">
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
            </Tooltip>
            <Tooltip title="复制为新模板">
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => duplicate(r)} />
            </Tooltip>
            <Popconfirm
              title="确认删除该模板？"
              description="会进入回收站，可随时恢复"
              okText="删除"
              cancelText="取消"
              onConfirm={() => remove(r)}
            >
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const myAttachments = attachments.filter((a) => draft.attachmentIds.includes(a.id));

  return (
    <div className="page">
      <PageHeader
        title="邮件模板"
        desc="富文本与 HTML 源码双模式；变量会在发送时按收件人替换，并做 HTML 转义"
        note={
          recycleBin ? (
            <span style={{ fontSize: 12, color: tokens.warning }}>
              正在查看回收站：这里的模板不能用于新建任务，恢复后回到列表
            </span>
          ) : undefined
        }
        extra={
          <>
            <Space size={8}>
              <span style={{ fontSize: 12, color: tokens.muted }}>回收站</span>
              <Switch size="small" checked={recycleBin} onChange={setRecycleBin} />
            </Space>
            <Button icon={<ReloadOutlined />} onClick={load} />
            {!recycleBin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建模板
              </Button>
            )}
          </>
        }
      />

      <Section title="模板列表" desc="模板被任务引用后不能彻底删除，避免历史投递对不上内容">
        <Card className="card-table">
          <Table<TemplateRow>
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns as any}
            pagination={false}
            locale={{ emptyText: '还没有模板，点右上角「新建模板」' }}
          />
        </Card>
      </Section>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={860}
        title={draft.id ? `编辑模板 · ${draft.name || '未命名'}` : '新建模板'}
        extra={
          <Space>
            <Button icon={<EyeOutlined />} onClick={doPreview}>
              预览
            </Button>
            <Button icon={<SendOutlined />} onClick={openTest}>
              测试发送
            </Button>
            <Button type="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </Space>
        }
      >
        <Form layout="vertical" requiredMark={false}>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item label="模板名称" style={{ flex: 1, marginRight: 8 }}>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="例如：老客户回访-2026Q4"
              />
            </Form.Item>
            <Form.Item label="邮件主题" style={{ flex: 2 }}>
              <Input
                value={draft.subject}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                placeholder="支持变量，例如：{{name}}，这是给你的专属邀请"
                showCount
                maxLength={255}
              />
            </Form.Item>
          </Space.Compact>

          <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
            <Space>
              <Segmented
                value={mode}
                onChange={(v) => setMode(v as 'rich' | 'html')}
                options={[
                  { label: '富文本', value: 'rich' },
                  { label: 'HTML 源码', value: 'html' },
                ]}
              />
              <Tooltip title="点击插入到光标处">
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    插入变量：
                  </Typography.Text>
                  {SAMPLE_VARS.map((v) => (
                    <Tag key={v} style={{ cursor: 'pointer', margin: 0 }} onClick={() => insertVar(v)}>
                      {v}
                    </Tag>
                  ))}
                </Space>
              </Tooltip>
            </Space>
            <Space>
              <span style={{ fontSize: 12, color: tokens.muted }}>打开追踪</span>
              <Switch
                size="small"
                checked={draft.trackOpen}
                onChange={(v) => setDraft((d) => ({ ...d, trackOpen: v }))}
              />
              <span style={{ fontSize: 12, color: tokens.muted }}>点击追踪</span>
              <Switch
                size="small"
                checked={draft.trackClick}
                onChange={(v) => setDraft((d) => ({ ...d, trackClick: v }))}
              />
            </Space>
          </Space>

          {mode === 'rich' ? (
            <RichEditor
              ref={editorRef}
              value={draft.html}
              onChange={(html) => setDraft((d) => ({ ...d, html }))}
            />
          ) : (
            <Input.TextArea
              ref={htmlAreaRef as any}
              value={draft.html}
              onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))}
              autoSize={{ minRows: 16, maxRows: 30 }}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
              spellCheck={false}
            />
          )}

          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>纯文本版本</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 6px' }}>
              留空则自动从 HTML 生成。建议保留：只有 HTML 的单部分邮件在垃圾邮件评分里明显吃亏。
            </Typography.Paragraph>
            <Input.TextArea
              value={draft.text}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder="留空自动生成"
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>附件</Typography.Text>
            <Alert
              type="warning"
              showIcon
              style={{ margin: '6px 0 8px' }}
              message="群发带附件会明显降低进箱率"
              description="很多邮箱对陌生发件人的附件直接拦到垃圾箱，.exe / .zip 更会被拒收。能用正文链接代替就尽量别加附件。"
            />
            <Space wrap>
              <Upload
                showUploadList={false}
                customRequest={({ file }) => doUpload(file as File)}
                maxCount={1}
              >
                <Button icon={<PaperClipOutlined />}>上传附件</Button>
              </Upload>
              {myAttachments.map((a) => (
                <Tag
                  key={a.id}
                  closable
                  onClose={async (e) => {
                    e.preventDefault();
                    setDraft((d) => ({ ...d, attachmentIds: d.attachmentIds.filter((x) => x !== a.id) }));
                  }}
                >
                  {a.filename}（{Math.round(a.size / 1024)} KB）
                </Tag>
              ))}
              {myAttachments.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  未添加附件
                </Typography.Text>
              )}
            </Space>
          </div>
        </Form>
      </Drawer>

      <Modal
        open={Boolean(preview)}
        onCancel={() => setPreview(null)}
        footer={<Button onClick={() => setPreview(null)}>关闭</Button>}
        width={760}
        title={`预览 · ${preview?.subject ?? ''}`}
      >
        {preview && (
          <>
            {preview.missing.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`这些变量没有对应数据：${preview.missing.join('、')}`}
                description="发送时会替换成空字符串，检查一下变量名是否写错。"
              />
            )}
            <Tabs
              items={[
                {
                  key: 'html',
                  label: 'HTML 效果',
                  children: (
                    <iframe
                      title="preview"
                      srcDoc={preview.html}
                      sandbox=""
                      style={{ width: '100%', height: 420, border: '1px solid #eee', borderRadius: 6 }}
                    />
                  ),
                },
                {
                  key: 'text',
                  label: '纯文本版本',
                  children: (
                    <pre
                      style={{
                        background: '#fafafa',
                        border: '1px solid #eee',
                        borderRadius: 6,
                        padding: 12,
                        maxHeight: 420,
                        overflow: 'auto',
                        fontSize: 12,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {preview.text}
                    </pre>
                  ),
                },
              ]}
            />
          </>
        )}
      </Modal>

      <Modal
        open={testOpen}
        onCancel={() => setTestOpen(false)}
        onOk={() => testForm.submit()}
        okText="发送"
        confirmLoading={testing}
        title="发送测试邮件"
        destroyOnClose
      >
        <Form form={testForm} layout="vertical" onFinish={doTestSend} requiredMark={false}>
          <Form.Item name="channelId" label="使用发件邮箱" rules={[{ required: true, message: '请选择发件邮箱' }]}>
            <Select
              options={channels.map((c) => ({
                value: c.id,
                label: `${c.name}（${c.fromEmail}，今日剩 ${c.remaining}）`,
                disabled: c.status !== 'active',
              }))}
            />
          </Form.Item>
          <Form.Item
            name="to"
            label="收件地址"
            rules={[
              { required: true, message: '请填写收件地址' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            测试发送会消耗该发件邮箱 1 封配额；为了让链接可点，测试邮件不注入追踪。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
