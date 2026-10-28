import { useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '../api';
import { metrics, tokens } from '../theme';

export default function Login({ onDone }: { onDone: () => void }) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { account: string; password: string }) => {
    setLoading(true);
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify(values) });
      message.success('登录成功');
      onDone();
    } catch (e: any) {
      message.error(e?.message ?? '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen" style={{ background: tokens.background }}>
      <Card style={{ width: 400 }} styles={{ body: { padding: 32 } }}>
        <div style={{ marginBottom: metrics.gridGutter }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.3, color: tokens.ink }}>
            邮件营销系统
          </h1>
        </div>

        <Form layout="vertical" onFinish={onFinish} requiredMark={false} autoComplete="on">
          <Form.Item
            name="account"
            label="账号"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="admin" autoComplete="username" />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="登录密码" autoComplete="current-password" />
          </Form.Item>

          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
