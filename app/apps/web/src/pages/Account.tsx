import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Col, Form, Input, Row } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api';
import PageHeader from '../components/PageHeader';
import Section from '../components/Section';
import { metrics, tokens } from '../theme';

interface AccountInfo {
  account: string;
  mustChangePassword: boolean;
  updatedAt?: string;
}

/**
 * 账号设置：与其它页面同一套骨架（页头 + 区块 + 卡片）。
 * 左侧表单、右侧状态与说明，避免整页只有一张窄卡片、右边一片空白。
 */
export default function Account() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<AccountInfo>('/auth/account');
      setInfo(r);
      form.setFieldsValue({ account: r.account });
    } catch {
      // 加载失败不打断页面，表单仍可手填
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (v: {
    account: string;
    currentPassword: string;
    newPassword?: string;
    confirmPassword?: string;
  }) => {
    setSaving(true);
    try {
      const r = await api<AccountInfo>('/auth/account', {
        method: 'PATCH',
        body: JSON.stringify({
          account: v.account?.trim(),
          currentPassword: v.currentPassword,
          newPassword: v.newPassword || undefined,
        }),
      });
      setInfo(r);
      form.setFieldsValue({ account: r.account });
      form.resetFields(['currentPassword', 'newPassword', 'confirmPassword']);
      message.success('已保存，下次登录请使用新凭据');
    } catch (e: any) {
      message.error(e?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="账号设置" />

      <Row gutter={metrics.gridGutter} align="stretch">
        <Col span={15}>
          <Section title="登录凭据" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
                <Row gutter={metrics.gridGutter}>
                  <Col span={12}>
                    <Form.Item
                      label="登录账号"
                      name="account"
                      rules={[
                        { required: true, message: '请填写账号' },
                        { min: 3, message: '账号至少 3 位' },
                      ]}
                    >
                      <Input placeholder="admin" autoComplete="username" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label="当前密码"
                      name="currentPassword"
                      rules={[{ required: true, message: '请输入当前密码' }]}
                    >
                      <Input.Password placeholder="验证身份" autoComplete="current-password" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="新密码" name="newPassword" rules={[{ min: 6, message: '新密码至少 6 位' }]}>
                      <Input.Password placeholder="不修改则留空" autoComplete="new-password" />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label="确认新密码"
                      name="confirmPassword"
                      dependencies={['newPassword']}
                      rules={[
                        ({ getFieldValue }) => ({
                          validator(_, value) {
                            const next = getFieldValue('newPassword');
                            if (!next || !value || next === value) return Promise.resolve();
                            return Promise.reject(new Error('两次输入不一致'));
                          },
                        }),
                      ]}
                    >
                      <Input.Password placeholder="再输一次" autoComplete="new-password" />
                    </Form.Item>
                  </Col>
                </Row>

                <Button type="primary" htmlType="submit" loading={saving}>
                  保存
                </Button>
              </Form>
            </Card>
          </Section>
        </Col>

        <Col span={9}>
          <Section title="当前状态" style={{ height: '100%' }}>
            <Card style={{ height: '100%' }}>
              <div style={{ fontSize: 12, color: tokens.muted }}>登录账号</div>
              <div style={{ marginTop: metrics.tight, fontSize: 15, color: tokens.ink, wordBreak: 'break-all' }}>
                {info?.account ?? '—'}
              </div>

              <div
                style={{
                  marginTop: metrics.gridGutter,
                  paddingTop: metrics.gridGutter,
                  borderTop: `1px solid ${tokens.border}`,
                  fontSize: 12,
                  color: tokens.muted,
                }}
              >
                最近修改
              </div>
              <div style={{ marginTop: metrics.tight, fontSize: 13, color: tokens.ink }}>
                {info?.updatedAt ? dayjs(info.updatedAt).format('YYYY-MM-DD HH:mm') : '—'}
              </div>

              {info?.mustChangePassword ? (
                <div
                  style={{
                    marginTop: metrics.gridGutter,
                    padding: `10px ${metrics.cardPaddingCompact}px`,
                    border: `1px solid ${tokens.warningSoft}`,
                    background: tokens.warningSoft,
                    borderRadius: metrics.cardRadius,
                    color: tokens.warning,
                    fontSize: 12,
                    lineHeight: 1.7,
                  }}
                >
                  仍在使用初始密码，任何知道默认账号的人都能登录，请立刻修改。
                </div>
              ) : (
                <div style={{ marginTop: metrics.gridGutter, fontSize: 12, color: tokens.muted, lineHeight: 1.8 }}>
                  这是唯一的登录入口。密码只保存哈希，系统里看不到明文；忘记了只能在服务器上重置。
                </div>
              )}
            </Card>
          </Section>
        </Col>
      </Row>
    </div>
  );
}
