export interface ApiError extends Error {
  status?: number;
}

/**
 * 统一请求封装：
 * - 会话失效（401）统一跳登录页，避免每个页面各写一遍
 * - 非 2xx 抛出带后端 message 的错误，直接可展示
 */
/** /auth/me 在首屏会被三处调用，这里合并成一次，避免开面板就发三个相同请求 */
let meInFlight: Promise<unknown> | null = null;
export function fetchMeCached<T = unknown>(): Promise<T> {
  if (!meInFlight) {
    meInFlight = api<T>('/auth/me').catch((e) => {
      meInFlight = null;
      throw e;
    });
  }
  return meInFlight as Promise<T>;
}

/** 登录状态变化时清掉缓存（登录、登出、改密后都要调） */
export function resetMeCache(): void {
  meInFlight = null;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401) {
    // 登录接口自己的 401 是"账号或密码不对"，不能当成会话失效去跳转，
    // 否则用户看到的是"未登录"而不是真正的失败原因
    const isLoginCall = path.startsWith('/auth/login');
    if (!isLoginCall && window.location.pathname !== '/login') {
      window.location.replace('/login');
    }
    let msg = '未登录';
    try {
      const body = await res.clone().json();
      if (body?.message) msg = body.message;
    } catch {
      // 忽略：响应不是 JSON 就用默认文案
    }
    const err: ApiError = new Error(msg);
    err.status = 401;
    throw err;
  }

  const raw = await res.text();
  let payload: any = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!res.ok) {
    const msg =
      (payload && (payload.message || payload.error)) ||
      (Array.isArray(payload?.message) ? payload.message.join('；') : null) ||
      `请求失败（${res.status}）`;
    const err: ApiError = new Error(typeof msg === 'string' ? msg : `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }

  return payload as T;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  dbLatencyMs: number;
  uptimeSec: number;
  node: string;
  time: string;
  error: string | null;
}

export interface Alert {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  hint?: string;
}

export interface Overview {
  today: { day: string; sent: number; opened: number; clicked: number; failed: number };
  quota: {
    /** 发件邮箱总数与可用数 */
    total: number;
    active: number;
    totalLimit: number;
    used: number;
    remaining: number;
  };
  queue: { pending: number; sending: number; overdue: number; failed: number; suppressed: number };
  totals: {
    contacts: number;
    reachable: number;
    /** 地址不存在（硬退信被拉黑）的联系人数 */
    undeliverable: number;
    campaigns: number;
    activeCampaigns: number;
    doneCampaigns: number;
  };
  accounts: {
    id: number;
    fromEmail: string;
    host: string;
    username: string;
    status: string;
    used: number;
    limit: number;
    remaining: number;
    consecutiveFailures: number;
    lastError: string | null;
    lastErrorAt: string | null;
    lastOkAt: string | null;
  }[];
  alerts: Alert[];
  generatedAt: string;
}

export interface TrendPoint {
  day: string;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
}

export interface ChannelStat {
  id: number;
  fromEmail: string;
  host: string;
  username: string;
  status: string;
  channelCount: number;
  usedToday: number;
  dailyLimit: number;
  remaining: number;
  sent: number;
  failed: number;
  suppressed: number;
  successRate: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastOkAt: string | null;
}

export interface CampaignStat {
  id: number;
  name: string;
  status: string;
  totalCount: number;
  sent: number;
  failed: number;
  suppressed: number;
  pending: number;
  delivered: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
}

export interface OpsCheck {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'skip';
  detail: string;
  value?: string;
}

export interface AuditLog {
  id: number;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** 文件上传单独走一条通道：不能让浏览器自己设 Content-Type，否则 boundary 会丢 */export async function upload<T = unknown>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);

  const res = await fetch(`/api${path}`, {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
  });

  const raw = await res.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }

  if (res.status === 401) {
    window.location.replace('/login');
    throw new Error('未登录');
  }
  if (!res.ok) {
    const msg =
      (payload && (Array.isArray(payload.message) ? payload.message.join('；') : payload.message)) ||
      `上传失败（${res.status}）`;
    throw new Error(msg);
  }
  return payload as T;
}
