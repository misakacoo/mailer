import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { log } from './logger';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    log.info('数据库连接已建立');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    log.info('数据库连接已关闭');
  }
}
