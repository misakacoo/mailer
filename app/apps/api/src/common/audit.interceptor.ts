import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { PrismaService } from './prisma.service';
import { log } from './logger';

/**
 * 审计拦截器：记录所有写操作。
 *
 * 用拦截器而不是在各 service 里逐处调用，是因为后者一定会漏——
 * 新加一个接口时很容易忘记补审计，而安全审计的价值恰恰在于"没有缺口"。
 * 代价是拿不到业务语义（比如"改了哪个字段"），只记录 METHOD + PATH。
 * 这对"谁在什么时间动了什么"这个问题已经够用。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const method: string = req.method ?? 'GET';

    // 读操作不记；追踪像素是访客行为，不是后台操作
    const url: string = req.originalUrl ?? req.url ?? '';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next.handle();
    if (url.startsWith('/api/t/')) return next.handle();

    const started = Date.now();
    const record = (statusCode: number, error?: string) => {
      const action = this.actionName(method, url, statusCode);
      const detail: Record<string, unknown> = {
        method,
        path: url,
        status: statusCode,
        elapsedMs: Date.now() - started,
        // 单管理员也记上操作者：将来加人或多账号时日志才有归属
        actor: (req as any).user?.email ?? (req as any).user?.sub ?? null,
      };
      if (error) detail.error = error.slice(0, 500);
      // 审计写入失败绝不能影响业务响应，所以只记日志
      this.prisma.auditLog
        .create({
          data: {
            action,
            target: this.targetOf(url),
            detail: detail as any,
            ip: this.clientIp(req),
          },
        })
        .catch((e) => log.warn({ err: e?.message ?? String(e), action }, '审计日志写入失败'));
    };

    return next.handle().pipe(
      tap(() => record(200)),
      catchError((err) => {
        const status = err?.status ?? 500;
        record(status, err?.message ?? String(err));
        return throwError(() => err);
      }),
    );
  }

  /** 把 HTTP 语义翻译成能读的动作名，避免前端再拼一遍 */
  private actionName(method: string, url: string, status: number): string {
    const path = url.split('?')[0];
    const failed = status >= 400;

    if (/\/auth\/login$/.test(path)) return failed ? 'auth.login.failed' : 'auth.login';
    if (/\/auth\/logout$/.test(path)) return 'auth.logout';
    if (/\/auth\/account$/.test(path)) return failed ? 'auth.account.failed' : 'auth.account.update';
    if (/\/ops\/audit-logs$/.test(path) && method === 'DELETE') {
      return failed ? 'ops.audit.clear.failed' : 'ops.audit.clear';
    }

    const table = path.replace(/^\/api\//, '').split('/')[0] ?? '';
    const verbMap: Record<string, string> = {
      POST: 'create',
      PATCH: 'update',
      PUT: 'update',
      DELETE: 'delete',
    };
    // 取路径里最后一个非数字段作为子动作：/campaigns/3/start -> start，
    // /ops/mark-backup -> mark-backup，/contacts/import/preview -> preview。
    // 只按固定下标取会在不同深度的路由上错位。
    const rest = path.split('/').filter(Boolean).slice(2);
    const sub = rest.filter((p) => !/^\d+$/.test(p)).pop() ?? null;
    const verb = sub ?? verbMap[method] ?? method.toLowerCase();
    return `${table}.${verb}${failed ? '.failed' : ''}`;
  }

  private targetOf(url: string): string | null {
    const m = url.split('?')[0].match(/^\/api\/([^/]+)\/(\d+)/);
    return m ? `${m[1]}#${m[2]}` : null;
  }

  private clientIp(req: any): string | null {
    // 用 Express 按 trust proxy 白名单算出来的 req.ip，不直接读原始请求头，
    // 否则任何客户端加一行 X-Forwarded-For 就能伪造审计来源
    const direct = typeof req.ip === 'string' ? req.ip : null;
    if (direct) return direct.replace(/^::ffff:/, '').slice(0, 64);
    const xf = req.headers?.['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim().slice(0, 64);
    return (req.ip ?? req.socket?.remoteAddress ?? null) as string | null;
  }
}
