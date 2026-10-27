import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/auth.guard';
import {
  CreateTemplateDto,
  PreviewDto,
  TestSendTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { TemplatesService } from './templates.service';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /** deleted=1 查回收站 */
  @Get()
  list(@Query('deleted') deleted?: string) {
    return this.templates.list(deleted === '1');
  }

  @Post(':id/restore')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.templates.restore(id);
  }

  @Post(':id/purge')
  purge(@Param('id', ParseIntPipe) id: number) {
    return this.templates.purge(id);
  }

  @Post()
  create(@Body() dto: CreateTemplateDto) {
    return this.templates.create(dto);
  }

  @Post('preview')
  preview(@Body() dto: PreviewDto) {
    return this.templates.preview(dto);
  }

  // ---- 附件：必须声明在 :id 之前，否则 "attachments" 会被当成 id ----

  @Get('attachments')
  listAttachments() {
    return this.templates.listAttachments();
  }

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  uploadAttachment(@UploadedFile() file: Express.Multer.File) {
    return this.templates.uploadAttachment(file);
  }

  @Delete('attachments/:id')
  removeAttachment(@Param('id', ParseIntPipe) id: number) {
    return this.templates.removeAttachment(id);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.templates.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTemplateDto) {
    return this.templates.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.templates.remove(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id', ParseIntPipe) id: number) {
    return this.templates.duplicate(id);
  }

  @Post(':id/test-send')
  testSend(@Param('id', ParseIntPipe) id: number, @Body() dto: TestSendTemplateDto) {
    return this.templates.testSend(id, dto);
  }
}
