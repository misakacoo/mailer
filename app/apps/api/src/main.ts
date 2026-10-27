import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { loadConfig } from './common/config';
import { PinoLoggerService, log } from './common/logger';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  // 写操作全部留痕，避免逐处调用时漏记
  app.useGlobalInterceptors(app.get(AuditInterceptor));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.enableShutdownHooks();

  // 只信任反向代理传来的 X-Forwarded-For，别的一律不信。
  // uniquelocal 覆盖 10/8、172.16/12、192.168/16：容器部署时请求来自 docker 网桥，
  // 只写 loopback 会导致 req.ip 记成网桥地址，审计日志里的 IP 全部失真且不报错。
  const instance = app.getHttpAdapter().getInstance();
  instance.set('trust proxy', 'loopback, uniquelocal');
  instance.disable('x-powered-by');

  await app.listen(cfg.port, cfg.host);

  log.info(
    { host: cfg.host, port: cfg.port, env: process.env.NODE_ENV ?? 'development' },
    'API 已启动',
  );
}

bootstrap().catch((e) => {
  console.error('[fatal] API 启动失败：', e);
  process.exit(1);
});
