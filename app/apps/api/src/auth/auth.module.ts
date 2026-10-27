import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../common/config';
import { SESSION_TTL_MS } from './auth.constants';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: Math.floor(SESSION_TTL_MS / 1000) },
      }),
    }),
  ],
  controllers: [AuthController],
  // JwtAuthGuard 会被其它模块的控制器实例化，必须导出，否则启动即报依赖解析失败
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
