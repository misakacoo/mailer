import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PinoLoggerService, log } from './common/logger';
import { PrismaService } from './common/prisma.service';
import { SenderService } from './sender/sender.service';
import { BounceService } from './sender/bounce.service';
import { SchedulerService } from './sender/scheduler.service';
import { ImportService } from './contacts/importer/import.service';

const HEARTBEAT_KEY = 'worker_heartbeat';
const HEARTBEAT_MS = 30_000;

/**
 * Worker 进程：只做一件事——取任务、发信、落状态。
 * 不监听端口，独立的 systemd 服务，崩了由 systemd 重启。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService());
  app.enableShutdownHooks();

  const sender = app.get(SenderService);
  const prisma = app.get(PrismaService);

  /**
   * 心跳：面板要能在发送进程悄悄死掉时报警。
   * 光看 systemd 状态不够——进程活着但主循环卡死时，systemd 依然显示 active。
   */
  const beat = () => {
    prisma.systemState
      .upsert({
        where: { key: HEARTBEAT_KEY },
        create: { key: HEARTBEAT_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      })
      .catch((e) => log.warn({ err: e?.message ?? String(e) }, '心跳写入失败'));
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);

  const recovered = await sender.recoverStale();
  log.info({ recovered }, 'worker 已启动，遗留的 sending 记录已回收');
  let lastRecoverAt = Date.now();

  const bounce = app.get(BounceService);
  // 置 0 让退信解析在启动后立刻跑一次，之后每 10 分钟一轮
  let lastBounceAt = 0;
  let bounceRunning = false;

  /**
   * 定时发送调度：每 30 秒看一次有没有到点的任务。
   * 同样刻意不 await —— 展开几千个收件人要几百毫秒到几秒，
   * 卡住主循环就等于让正在发的信停下来。晚 30 秒启动没有任何业务影响。
   */
  const scheduler = app.get(SchedulerService);
  let lastScheduleAt = 0;
  let scheduleRunning = false;

  /**
   * 导入任务推进：大文件导入在 worker 里分块处理，每块 500 行。
   * 同样不 await——导入慢不能拖住发信；反过来发信忙也不影响导入，
   * 只是 tick 之间间隔变长，进度走得慢一点而已。
   */
  const imports = app.get(ImportService);
  let lastImportAt = 0;
  let importRunning = false;
  let importWorked = false;

  /**
   * 看门狗定时器。
   * 只要有一处 await 卡在永不 resolve 的 Promise 上（IMAP 连接异常时很容易出现），
   * 事件循环就会枯竭，Node 会以退出码 0 安静退出，systemd 只会当成"正常退出"再拉起一个。
   * 空转定时器保证事件循环不会被饿死，进程的生死只由我们自己的逻辑决定。
   */
  const keepAlive = setInterval(() => undefined, 30_000);

  const shutdown = (signal: string) => {
    if (sender.stopped) return;
    // 只置标记，让 tick 自然收尾，绝不打断正在进行的 SMTP 会话
    sender.stop();
    log.info({ signal }, '收到退出信号，等待当前这封发送完成');
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'worker 未处理的 Promise 拒绝');
  });
  // 兜底：真出现了未捕获异常，也要把堆栈写进日志再退，
  // 否则 systemd 只看到 exit-code，重启次数一路涨却查不到原因
  process.on('uncaughtException', (err) => {
    log.error({ err: err?.message, stack: err?.stack }, 'worker 未捕获异常，进程退出等待重启');
    process.exit(1);
  });

  while (!sender.stopped) {
    try {
      // 定期回收僵尸 sending：只在启动时回收的话，运行期崩掉的那条会一直卡着
      if (Date.now() - lastRecoverAt > 60000) {
        const n = await sender.recoverStale();
        if (n > 0) log.warn({ recovered: n }, '回收了卡在 sending 的记录');
        lastRecoverAt = Date.now();
      }

      // 退信解析：服务商异步退信，只能靠轮询收件箱拿回来。
      // 刻意不 await —— IMAP 客户端在网络异常时可能长时间不返回，
      // 一旦阻塞主循环，整个发送引擎就停了。退信晚几分钟处理没有任何影响。
      if (Date.now() - lastBounceAt > 10 * 60 * 1000 && !bounceRunning) {
        bounceRunning = true;
        lastBounceAt = Date.now();
        bounce
          .pollAll()
          .then((r) => {
            if (r && r.suppressed > 0) log.info({ ...r }, '本轮新增抑制');
          })
          .catch((e) => log.warn({ err: e?.message ?? String(e) }, '退信解析异常，跳过本轮'))
          .finally(() => {
            bounceRunning = false;
          });
      }

      // 定时任务到点启动。放在发送 tick 之前：新任务能立刻参与本轮调度，
      // 而不是等到下一次循环才开始发。
      if (Date.now() - lastScheduleAt > 30000 && !scheduleRunning) {
        scheduleRunning = true;
        lastScheduleAt = Date.now();
        scheduler
          .runDue()
          .then((fired) => {
            if (fired.length > 0) log.info({ campaignIds: fired }, '定时任务已启动');
          })
          .catch((e) => log.warn({ err: e?.message ?? String(e) }, '定时调度异常，跳过本轮'))
          .finally(() => {
            scheduleRunning = false;
          });
      }

      // 导入任务分块推进（有进行中的任务时每块 500 行）
      if (Date.now() - lastImportAt > 800 && !importRunning) {
        importRunning = true;
        lastImportAt = Date.now();
        imports
          .tick()
          .then((worked) => {
            // 刚处理完一个分块说明导入还在进行：把下面的空转睡眠压短，
            // 否则空闲时 3 秒一圈的节奏会让两万行的导入拖上两分钟
            importWorked = worked;
          })
          .catch((e) => log.warn({ err: e?.message ?? String(e) }, '导入分块处理异常'))
          .finally(() => {
            importRunning = false;
          });
      }

      const result = await sender.tick();
      if (result.action === 'sent' || result.action === 'retry' || result.action === 'failed') {
        log.info(
          {
            action: result.action,
            campaignId: result.campaignId,
            email: result.email,
            waitMs: result.waitMs,
          },
          'tick 完成',
        );
      }
      // 导入进行中时空转睡眠压到 800ms；发信间隔该多久还是多久（waitMs 是发信节流的结果，
      // 只有队列为空时的 3 秒空闲等待会被压短，不会突破账号/任务的最小间隔）
      const waitMs = importWorked ? Math.min(result.waitMs, 800) : result.waitMs;
      await sleepInterruptible(sender, waitMs);
    } catch (e: any) {
      log.error({ err: e?.message ?? String(e) }, 'tick 异常，5 秒后重试');
      await sleepInterruptible(sender, 5000);
    }
  }

  clearInterval(keepAlive);
  clearInterval(heartbeat);
  await app.close();
  log.info('worker 已退出');
}

/** 分段睡眠：收到退出信号能尽快响应，而不是傻等 30 秒 */
async function sleepInterruptible(sender: SenderService, ms: number): Promise<void> {
  const end = Date.now() + Math.min(Math.max(ms, 0), 20000);
  while (!sender.stopped && Date.now() < end) {
    const step = Math.min(400, Math.max(1, end - Date.now()));
    await new Promise((r) => setTimeout(r, step));
  }
}

bootstrap().catch((e) => {
  console.error('[fatal] worker 启动失败：', e);
  process.exit(1);
});
