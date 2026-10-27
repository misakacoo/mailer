import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ImportService } from './importer/import.service';

@Module({
  imports: [AuthModule],
  controllers: [ContactsController],
  providers: [ContactsService, ImportService],
  // worker 的分块导入循环要通过 app.get 拿到 ImportService
  exports: [ContactsService, ImportService],
})
export class ContactsModule {}
