import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Form, Input, Row } from 'antd';
import { api } from '../api';
import PageHeader from '../components/PageHeader';
import Section from '../components/Section';
import { metrics, tokens } from '../theme';

/**
 * 管理员账号：独立于系统运维页。
 * 改账号/密码是敏感操作，放单独一页可以少一层视觉干扰，
 * 也让「改完密码去哪儿确认」这件事有明确去处。
 */
export default function Account() {
  const [form] = Form.useForm();
  const [info, setInfo] = useState<{ account: string; mustChangePassword: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ account: string; mustChangePassword: boolean }>('/auth/account');
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
      const r = await api<{ account: string; mustChangePassword: boolean }>('/auth/account', {
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="账号设置"
        desc="登录用的账号与密码。修改前需要验证当前密码，保存后立即生效，下次登录用新凭据"
      />

      <Section title="管理员账号">
        <Card style={{ maxWidth: 640 }}>
          <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
            {info?.mustChangePassword && (
              <div
                style={{
                  padding: `12px ${metrics.cardPadding}px`,
                  marginBottom: metrics.gridGutter,
                  border: `1px solid ${tokens.warningSoft}`,
                  background: tokens.warningSoft,
                  borderRadius: metrics.cardRadius,
                  color: tokens.warning,
                  fontSize: 13,
                }}
              >
                当前仍在使用初始密码，任何知道默认账号的人都能登录，请立刻修改。
              </div>
            )}

            <Form.Item
              label="登录账号"
              name="account"
              rules={[
                { required: true, message: '请填写账号' },
                { min: 3, message: '账号至少 3 位' },
              ]}
            >
              <Input placeholder="admin 或 you@example.com" autoComplete="username" />
            </Form.Item>

            <Form.Item
              label="当前密码"
              name="currentPassword"
              rules={[{ required: true, message: '请输入当前密码' }]}
            >
              <Input.Password
                placeholder="修改前需验证，防止他人拿到已登录的浏览器"
                autoComplete="current-password"
              />
            </Form.Item>

            <Row gutter={metrics.gridGutter}>
              <Col span={12}>
                <Form.Item label="新密码" name="newPassword" rules={[{ min: 6, message: '新密码至少 6 位' }]}>
                  <Input.Password placeholder="不改可留空" autoComplete="new-password" />
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
    </div>
  );
}
