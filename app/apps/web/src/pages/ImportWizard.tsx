import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { api, upload } from '../api';
import { metrics, tokens } from '../theme';

interface ListRow {
  id: number;
  name: string;
  contactCount: number;
}

interface Preview {
  token: string;
  filename: string;
  ext: string;
  size: number;
  encoding: string;
  sheetName: string | null;
  hasHeader: boolean;
  columns: string[];
  totalRows: number;
  suggested: {
    emailColumn: number;
    nameColumn: number | null;
    extraColumns: { index: number; key: string }[];
  };
  sample: string[][];
  warnings: string[];
}

/**
 * 导入任务：大文件在 worker 里分块处理。
 * processedRows 是断点——暂停/继续/取消都作用在它上面，
 * 所以关闭这个弹窗任务也不会丢，重新打开还能看到进度。
 */
interface ImportJob {
  id: number;
  filename: string;
  totalRows: number;
  processedRows: number;
  imported: number;
  existing: number;
  addedToList: number;
  invalid: number;
  duplicateInFile: number;
  suppressed: number;
  empty: number;
  samples: { invalid: string[]; duplicateInFile: string[]; suppressed: string[] };
  status: 'pending' | 'running' | 'paused' | 'done' | 'canceled' | 'failed';
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_STATUS: Record<ImportJob['status'], { label: string; color: string }> = {
  pending: { label: '排队中', color: tokens.muted },
  running: { label: '导入中', color: '#a96510' },
  paused: { label: '已暂停', color: '#d97706' },
  done: { label: '已完成', color: '#16a34a' },
  canceled: { label: '已取消', color: tokens.muted },
  failed: { label: '失败', color: '#bd2c32' },
};

interface ExtraCol {
  index: number;
  key: string;
  enabled: boolean;
}

export default function ImportWizard({
  open,
  lists,
  defaultListId,
  onClose,
  onDone,
}: {
  open: boolean;
  lists: ListRow[];
  defaultListId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [listId, setListId] = useState<number | null>(defaultListId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [emailColumn, setEmailColumn] = useState<number>(0);
  const [nameColumn, setNameColumn] = useState<number | null>(null);
  const [extras, setExtras] = useState<ExtraCol[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setPreview(null);
      setJob(null);
      setListId(defaultListId);
      setEmailColumn(0);
      setNameColumn(null);
      setExtras([]);
    }
  }, [open, defaultListId]);

  // 进行中的任务每 1.5 秒刷一次进度；结束即停
  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!open || !job) return;
    if (!['pending', 'running'].includes(job.status)) return;

    timerRef.current = window.setInterval(async () => {
      try {
        const j = await api<ImportJob>(`/contacts/import/jobs/${job.id}`);
        setJob(j);
        if (j.status === 'done') {
          onDone();
        }
        if (j.status === 'failed') {
          message.error(`导入失败：${j.error ?? '未知错误'}`);
        }
      } catch {
        // 单次轮询失败不打断，下一轮再试
      }
    }, 1500);

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id, job?.status]);

  const columnLabels = useMemo(
    () => (preview?.columns ?? []).map((c, i) => ({ value: i, label: `${i + 1}. ${c}` })),
    [preview],
  );

  const doPreview = async (file: File) => {
    setBusy(true);
    try {
      const p = await upload<Preview>('/contacts/import/preview', file);
      setPreview(p);
      setEmailColumn(p.suggested.emailColumn);
      setNameColumn(p.suggested.nameColumn);
      setExtras(
        p.columns.map((c, i) => ({
          index: i,
          key: c,
          enabled: p.suggested.extraColumns.some((e) => e.index === i),
        })),
      );
      setStep(1);
      if (p.warnings.length) p.warnings.forEach((w) => message.warning(w));
    } catch (e: any) {
      message.error(e?.message ?? '解析失败');
    } finally {
      setBusy(false);
    }
  };

  /** 建任务而不是同步导入：立即返回，进度在下一步里实时看，随时能暂停/取消 */
  const doStart = async () => {
    if (!preview) return;
    if (listId === null) {
      message.warning('请先选择要导入的分组');
      return;
    }
    if (emailColumn === null || emailColumn === undefined) {
      message.warning('请指定邮箱所在的列');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ id: number; totalRows: number }>('/contacts/import/start', {
        method: 'POST',
        body: JSON.stringify({
          token: preview.token,
          listId,
          mapping: {
            emailColumn,
            nameColumn: nameColumn ?? null,
            extraColumns: extras
              .filter((e) => e.enabled && e.index !== emailColumn && e.index !== nameColumn)
              .map((e) => ({ index: e.index, key: e.key.trim() || `字段${e.index + 1}` })),
          },
        }),
      });
      const j = await api<ImportJob>(`/contacts/import/jobs/${r.id}`);
      setJob(j);
      setStep(2);
    } catch (e: any) {
      message.error(e?.message ?? '创建导入任务失败');
    } finally {
      setBusy(false);
    }
  };

  const jobAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!job) return;
    if (action === 'cancel') {
      modal.confirm({
        title: '取消这个导入任务？',
        content: `已入库的 ${job.imported} 条联系人会保留，剩余 ${(job.totalRows - job.processedRows).toLocaleString()} 行不再处理，且无法恢复。`,
        okText: '取消任务',
        okButtonProps: { danger: true },
        cancelText: '继续导入',
        onOk: async () => {
          await api(`/contacts/import/jobs/${job.id}/cancel`, { method: 'POST' });
          const j = await api<ImportJob>(`/contacts/import/jobs/${job.id}`);
          setJob(j);
        },
      });
      return;
    }
    try {
      await api(`/contacts/import/jobs/${job.id}/${action}`, { method: 'POST' });
      const j = await api<ImportJob>(`/contacts/import/jobs/${job.id}`);
      setJob(j);
    } catch (e: any) {
      message.error(e?.message ?? '操作失败');
    }
  };

  const sampleColumns = (preview?.columns ?? []).map((c, i) => ({
    title: (
      <span>
        {c}
        {i === emailColumn ? <Tag color="blue" style={{ marginLeft: 4 }}>邮箱</Tag> : null}
        {i === nameColumn ? <Tag color="green" style={{ marginLeft: 4 }}>姓名</Tag> : null}
      </span>
    ),
    dataIndex: String(i),
    ellipsis: true,
  }));

  const sampleData = (preview?.sample ?? []).map((row, idx) => {
    const o: Record<string, string> = { key: String(idx) };
    row.forEach((cell, i) => (o[String(i)] = cell));
    return o;
  });

  const finished = job !== null && ['done', 'canceled', 'failed'].includes(job.status);
  const percent = job && job.totalRows > 0 ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={860}
      title="导入联系人"
      destroyOnClose
      footer={
        step === 0
          ? [<Button key="c" onClick={onClose}>取消</Button>]
          : step === 1
            ? [
                <Button key="back" onClick={() => setStep(0)}>上一步</Button>,
                <Button key="ok" type="primary" loading={busy} onClick={doStart}>
                  开始导入 {preview ? `${preview.totalRows} 行` : ''}
                </Button>,
              ]
            : finished
              ? [
                  <Button key="again" onClick={() => setStep(0)}>再导一份</Button>,
                  <Button key="done" type="primary" onClick={onClose}>完成</Button>,
                ]
              : [
                  <Button key="close" onClick={onClose}>
                    后台运行，关闭窗口
                  </Button>,
                  job?.status === 'running' && (
                    <Button key="pause" onClick={() => void jobAction('pause')}>
                      暂停
                    </Button>
                  ),
                  job?.status === 'paused' && (
                    <Button key="resume" type="primary" onClick={() => void jobAction('resume')}>
                      继续
                    </Button>
                  ),
                  <Button key="cancel" danger onClick={() => void jobAction('cancel')}>
                    取消任务
                  </Button>,
                ]
      }
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 20 }}
        items={[{ title: '上传文件' }, { title: '确认字段' }, { title: '导入进度' }]}
      />

      {step === 0 && (
        <div>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>导入到分组</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                placeholder={lists.length ? '选择一个分组' : '还没有分组，请先在左侧新建'}
                value={listId ?? undefined}
                onChange={(v) => setListId(v)}
                options={lists.map((l) => ({ value: l.id, label: `${l.name}（${l.contactCount} 人）` }))}
              />
            </div>

            <Upload.Dragger
              accept=".csv,.xlsx,.xls,.txt"
              maxCount={1}
              showUploadList={false}
              disabled={busy}
              customRequest={({ file }) => doPreview(file as File)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
              <p className="ant-upload-hint">
                支持 CSV / XLSX / XLS / TXT，单文件 ≤ 25MB。CSV 的 UTF-8 与 GBK 编码都能识别；
                TXT 支持每行一个邮箱，也支持用逗号、Tab 或分号分隔多列。
              </p>
            </Upload.Dragger>

            <Alert
              type="info"
              showIcon
              message="导入规则"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>邮箱统一转小写并去空格；格式非法的行会被跳过并计数</li>
                  <li>库里已存在的联系人不会重复创建，但会补进所选分组；地址不存在（硬退信）的地址直接跳过</li>
                  <li>大文件在后台分批导入，期间可以暂停、继续或取消，关掉窗口任务照常进行</li>
                  <li>除邮箱和姓名外的列会成为联系人的自定义字段</li>
                </ul>
              }
            />
          </Space>
        </div>
      )}

      {step === 1 && preview && (
        <div>
          <Space wrap size={16} style={{ marginBottom: 12 }}>
            <Tag>文件：{preview.filename}</Tag>
            <Tag>编码：{preview.encoding}</Tag>
            {preview.sheetName && <Tag>工作表：{preview.sheetName}</Tag>}
            <Tag color="blue">数据行：{preview.totalRows}</Tag>
            <Tag color={preview.hasHeader ? 'green' : 'orange'}>
              {preview.hasHeader ? '已识别表头' : '未识别表头'}
            </Tag>
          </Space>

          <Space style={{ width: '100%', marginBottom: 12 }} size={12}>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>邮箱所在列 *</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={emailColumn}
                onChange={setEmailColumn}
                options={columnLabels}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>姓名所在列</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                allowClear
                placeholder="不导入姓名"
                value={nameColumn ?? undefined}
                onChange={(v) => setNameColumn(v ?? null)}
                options={columnLabels}
              />
            </div>
          </Space>

          <Typography.Text strong>其余列作为自定义字段</Typography.Text>
          <div
            style={{
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: 16,
              margin: `8px 0 ${metrics.gridGutter}px`,
              maxHeight: 160,
              overflow: 'auto',
            }}
          >
            {extras.filter((e) => e.index !== emailColumn && e.index !== nameColumn).length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                没有其它列
              </Typography.Text>
            ) : (
              extras
                .filter((e) => e.index !== emailColumn && e.index !== nameColumn)
                .map((e) => (
                  <Space key={e.index} style={{ marginBottom: metrics.tight, width: '48%' }} size={8}>
                    <Checkbox
                      checked={e.enabled}
                      onChange={(ev) =>
                        setExtras((prev) =>
                          prev.map((x) => (x.index === e.index ? { ...x, enabled: ev.target.checked } : x)),
                        )
                      }
                    />
                    <Typography.Text style={{ fontSize: 13, minWidth: 84 }}>{preview.columns[e.index]}</Typography.Text>
                    <Input
                      size="small"
                      style={{ width: 130 }}
                      value={e.key}
                      disabled={!e.enabled}
                      onChange={(ev) =>
                        setExtras((prev) =>
                          prev.map((x) => (x.index === e.index ? { ...x, key: ev.target.value } : x)),
                        )
                      }
                    />
                  </Space>
                ))
            )}
          </div>

          <Typography.Text strong>数据预览（前 {sampleData.length} 行）</Typography.Text>
          <Table
            size="small"
            style={{ marginTop: 6 }}
            rowKey="key"
            columns={sampleColumns}
            dataSource={sampleData}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        </div>
      )}

      {step === 2 && job && (
        <div>
          <Space wrap size={16} style={{ marginBottom: 12 }}>
            <Tag>文件：{job.filename}</Tag>
            <Tag color={JOB_STATUS[job.status].color}>
              {JOB_STATUS[job.status].label}
            </Tag>
            <Tag color="blue">
              {job.processedRows.toLocaleString()} / {job.totalRows.toLocaleString()} 行
            </Tag>
          </Space>

          <Progress
            percent={percent}
            status={job.status === 'failed' ? 'exception' : finished ? 'normal' : 'active'}
            showInfo={false}
            style={{ marginBottom: metrics.tight }}
          />
          <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 16 }}>
            {job.status === 'done' && '导入完成。'}
            {job.status === 'running' && '正在后台分批导入，可以随时暂停；关掉这个窗口任务也会继续。'}
            {job.status === 'paused' && '已暂停，游标停在当前进度，点「继续」从断点接着导入。'}
            {job.status === 'pending' && '排队等待处理…'}
            {job.status === 'canceled' &&
              `已取消。已入库的 ${job.imported.toLocaleString()} 条联系人保留，剩余 ${(job.totalRows - job.processedRows).toLocaleString()} 行未处理。`}
            {job.status === 'failed' && `导入失败：${job.error ?? '未知错误'}。文件已清理，请重新上传。`}
          </div>

          <Space size={metrics.gridGutter} wrap style={{ marginBottom: 0 }}>
            <Statistic title="成功导入" value={job.imported} valueStyle={{ color: tokens.successDeep }} />
            <Statistic title="已在库中" value={job.existing} />
            <Statistic title="加入分组" value={job.addedToList} />
            <Statistic title="格式非法" value={job.invalid} valueStyle={{ color: tokens.destructive }} />
            <Statistic title="文件内重复" value={job.duplicateInFile} />
            <Statistic title="地址不存在" value={job.suppressed} />
            <Statistic title="空行" value={job.empty} />
          </Space>

          {job.status === 'done' && (
            <Alert
              type="info"
              showIcon
              message={`共读取 ${job.totalRows.toLocaleString()} 行，成功导入 ${job.imported.toLocaleString()} 条新联系人`}
              description="库里已存在的联系人不会重复创建，但已补进所选分组；地址不存在（硬退信）的地址始终跳过。"
            />
          )}

          {(job.samples.invalid.length > 0 ||
            job.samples.duplicateInFile.length > 0 ||
            job.samples.suppressed.length > 0) && (
            <div style={{ marginTop: 16 }}>
              {job.samples.invalid.length > 0 && (
                <p style={{ marginBottom: 6 }}>
                  <b>非法样本：</b>
                  <span className="mono">{job.samples.invalid.join('，')}</span>
                </p>
              )}
              {job.samples.duplicateInFile.length > 0 && (
                <p style={{ marginBottom: 6 }}>
                  <b>文件内重复样本：</b>
                  <span className="mono">{job.samples.duplicateInFile.join('，')}</span>
                </p>
              )}
              {job.samples.suppressed.length > 0 && (
                <p style={{ marginBottom: 0 }}>
                  <b>地址不存在样本：</b>
                  <span className="mono">{job.samples.suppressed.join('，')}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
