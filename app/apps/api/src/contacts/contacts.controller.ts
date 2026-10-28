import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ContactsService } from './contacts.service';
import {
  BatchDeleteContactsDto,
  BatchSetListsDto,
  CommitImportDto,
  CreateContactDto,
  QueryContactsDto,
  SetContactListsDto,
  UpdateContactDto,
} from './dto/contact.dto';
import { ImportService } from './importer/import.service';
import { ColumnMapping } from './importer/parser';

@UseGuards(JwtAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly importer: ImportService,
  ) {}

  @Get()
  list(@Query() q: QueryContactsDto) {
    return this.contacts.list(q);
  }

  @Get('stats')
  stats() {
    return this.contacts.stats();
  }

  @Post()
  create(@Body() dto: CreateContactDto) {
    return this.contacts.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContactDto) {
    return this.contacts.update(id, dto);
  }

  /** 替换分组归属：把已有联系人加入/移出分组 */
  @Put(':id/lists')
  setLists(@Param('id', ParseIntPipe) id: number, @Body() dto: SetContactListsDto) {
    return this.contacts.setLists(id, dto.listIds);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.contacts.remove(id);
  }

  /** 批量删除选中的联系人（含其抑制记录） */
  @Post('batch-delete')
  batchRemove(@Body() dto: BatchDeleteContactsDto) {
    return this.contacts.batchRemove(dto.ids);
  }

  /** 批量调整分组：追加或整组替换 */
  @Post('batch-lists')
  batchSetLists(@Body() dto: BatchSetListsDto) {
    return this.contacts.batchSetLists(dto.ids, dto.listIds, dto.replace ?? false);
  }

  /** 第一步：上传并解析，返回列信息与建议映射，不落库 */
  @Post('import/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  preview(@UploadedFile() file: Express.Multer.File) {
    return this.importer.preview(file);
  }

  /** 第二步：确认映射后建导入任务，由 worker 分批处理，立即返回 */
  @Post('import/start')
  start(@Body() dto: CommitImportDto) {
    return this.importer.startJob(dto.token, dto.listId, dto.mapping as unknown as ColumnMapping);
  }

  /** 最近的导入任务（含进行中的），用于向导恢复进度展示 */
  @Get('import/jobs')
  jobs(@Query('limit') limit?: string) {
    return this.importer.listJobs(Number(limit) || 20);
  }

  @Get('import/jobs/:id')
  job(@Param('id', ParseIntPipe) id: number) {
    return this.importer.getJob(id);
  }

  /** 暂停：游标停在分块边界，已入库的不回滚 */
  @Post('import/jobs/:id/pause')
  pause(@Param('id', ParseIntPipe) id: number) {
    return this.importer.pause(id);
  }

  @Post('import/jobs/:id/resume')
  resume(@Param('id', ParseIntPipe) id: number) {
    return this.importer.resume(id);
  }

  @Post('import/jobs/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.importer.cancel(id);
  }
}
