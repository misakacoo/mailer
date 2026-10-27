import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ChannelsService } from './channels.service';
import { CreateChannelDto, TestConnectionDto, TestSendDto, UpdateChannelDto } from './dto/channel.dto';

@UseGuards(JwtAuthGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list() {
    return this.channels.list();
  }

  @Get('presets')
  presets() {
    return this.channels.presets();
  }

  @Post()
  create(@Body() dto: CreateChannelDto) {
    return this.channels.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateChannelDto) {
    return this.channels.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.channels.remove(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id', ParseIntPipe) id: number) {
    return this.channels.duplicate(id);
  }

  /** 传 id 用已存密码；不传 id 则用请求体里的完整配置（用于保存前先测通） */
  @Post('test-connection')
  testConnection(@Body() dto: TestConnectionDto) {
    return this.channels.testConnection(dto);
  }

  @Post(':id/test-send')
  testSend(@Param('id', ParseIntPipe) id: number, @Body() dto: TestSendDto) {
    return this.channels.testSend(id, dto.to);
  }
}
