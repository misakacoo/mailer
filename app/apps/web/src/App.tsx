import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import Shell from './components/Shell';
import { fetchMeCached, resetMeCache } from './api';
import Channels from './pages/Channels';
import Campaigns from './pages/Campaigns';
import Contacts from './pages/Contacts';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Reports from './pages/Reports';
import Account from './pages/Account';
import Settings from './pages/Settings';
import Templates from './pages/Templates';

type AuthState = 'loading' | 'in' | 'out';

export default function App() {
  const [state, setState] = useState<AuthState>('loading');

  useEffect(() => {
    // 只有 401 才算未登录：网络抖动/后端重启时把人踢回登录页，
    // 会让人以为账号出了问题
    fetchMeCached()
      .then(() => setState('in'))
      .catch((e: any) => setState(e?.status === 401 ? 'out' : 'in'));
  }, []);

  if (state === 'loading') {
    return (
      <div className="center-screen">
        <Spin tip="正在检查登录状态…" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={state === 'in' ? <Navigate to="/" replace /> : <Login
          onDone={() => {
            resetMeCache();
            setState('in');
          }}
        />}
      />
      <Route
        path="/"
        element={state === 'in' ? <Shell onLogout={() => setState('out')} /> : <Navigate to="/login" replace />}
      >
        <Route index element={<Dashboard />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="templates" element={<Templates />} />
        <Route path="channels" element={<Channels />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="account" element={<Account />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
