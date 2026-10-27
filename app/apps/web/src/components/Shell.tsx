import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Layout, Menu, Space, Typography } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  ContactsOutlined,
  FileTextOutlined,
  InboxOutlined,
  LogoutOutlined,
  SendOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { metrics, tokens } from '../theme';

const { Header, Sider, Content } = Layout;

const ITEMS = [
  { key: '/', icon: <AppstoreOutlined />, label: '概览' },
  { key: '/contacts', icon: <ContactsOutlined />, label: '联系人' },
  { key: '/templates', icon: <FileTextOutlined />, label: '邮件模板' },
  { key: '/channels', icon: <InboxOutlined />, label: '发件账号' },
  { key: '/campaigns', icon: <SendOutlined />, label: '群发任务' },
  { key: '/reports', icon: <BarChartOutlined />, label: '统计报表' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统运维' },
  { key: '/account', icon: <UserOutlined />, label: '账号设置' },
];

export default function Shell({ onLogout }: { onLogout: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { message } = AntApp.useApp();
  const [mustChange, setMustChange] = useState(false);

  // 初始密码是 admin/admin，分发出去的系统如果不提醒，很多人会一直不改
  useEffect(() => {
    api<{ mustChangePassword?: boolean }>('/auth/me')
      .then((r) => setMustChange(Boolean(r?.mustChangePassword)))
      .catch(() => undefined);
  }, []);

  const selected = useMemo(() => {
    const hit = ITEMS.filter((i) => i.key !== '/' && loc.pathname.startsWith(i.key));
    return hit.length ? [hit[0].key] : ['/'];
  }, [loc.pathname]);

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // 退出失败也回登录页，不能卡住
    }
    message.success('已退出');
    onLogout();
    nav('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh', background: tokens.background }}>
      <Sider
        width={metrics.siderWidth}
        theme="light"
        style={{
          borderRight: `1px solid ${tokens.border}`,
          background: tokens.card,
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        {/* 品牌区与顶栏同高：两条水平轴线对齐，页面标题因此不会和导航错位 */}
        <div
          style={{
            height: metrics.headerHeight,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: `0 ${metrics.gridGutter}px`,
            borderBottom: `1px solid ${tokens.border}`,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: tokens.primary,
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            邮
          </div>
          <Typography.Text style={{ fontSize: 14, fontWeight: 600, color: tokens.ink }}>
            邮件营销系统
          </Typography.Text>
        </div>

        <Menu
          mode="inline"
          selectedKeys={selected}
          items={ITEMS}
          onClick={({ key }) => nav(key)}
          style={{
            borderInlineEnd: 'none',
            padding: `${metrics.snug}px ${metrics.tight + 2}px`,
            background: 'transparent',
          }}
        />
      </Sider>

      <Layout style={{ background: tokens.background, minWidth: 0 }}>
        <Header
          style={{
            background: tokens.card,
            borderBottom: `1px solid ${tokens.border}`,
            height: metrics.headerHeight,
            lineHeight: `${metrics.headerHeight}px`,
            padding: `0 ${metrics.pagePaddingX}px`,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Space size={metrics.snug}>
            <Typography.Text style={{ fontSize: 12, color: tokens.muted }}>管理员</Typography.Text>
            <span
              style={{
                width: 1,
                height: 14,
                background: tokens.border,
                display: 'inline-block',
              }}
            />
            <Button
              type="text"
              size="small"
              icon={<LogoutOutlined />}
              onClick={logout}
              style={{ color: tokens.foreground }}
            >
              退出
            </Button>
          </Space>
        </Header>

        {mustChange && (
          <div
            style={{
              background: tokens.warningSoft,
              borderBottom: `1px solid ${tokens.border}`,
              padding: `10px ${metrics.pagePaddingX}px`,
              fontSize: 13,
              color: tokens.warning,
            }}
          >
            当前仍在使用初始密码，任何知道默认账号的人都能登录。
            <Button type="link" size="small" onClick={() => nav('/account')} style={{ padding: '0 4px' }}>
              立即修改
            </Button>
          </div>
        )}

        {/*
          页面容器：宽屏居中，两侧固定 40px 呼吸区；
          下限 960 保证表格不会挤成逐字换行（不足时整体横向滚动）。
        */}
        <Content
          style={{
            padding: `${metrics.pagePaddingY}px ${metrics.pagePaddingX}px ${metrics.pagePaddingY + 8}px`,
            width: '100%',
          }}
        >
          <div
            style={{
              maxWidth: metrics.pageMaxWidth,
              minWidth: metrics.pageMinWidth,
              margin: '0 auto',
            }}
          >
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
