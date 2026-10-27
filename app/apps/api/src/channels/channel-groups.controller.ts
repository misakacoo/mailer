import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ChannelsService } from './channels.service';

export class CreateChannelGroupDto {
  @IsString()
  @MinLength(1, { message: '请填写分组名称' })
  @MaxLength(32)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}

export class UpdateChannelGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}

/**
 * 发件账号分组。
 * 任务按分组选号：一个账号下常有多条通道（不同 fromName），
 * 逐条挑通道既费事又容易漏配额，分组才是业务上的选择单位。
 */
@UseGuards(JwtAuthGuard)
@Controller('channel-groups')
export class ChannelGroupsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list() {
    return this.channels.listGroups();
  }

  @Post()
  create(@Body() dto: CreateChannelGroupDto) {
    return this.channels.createGroup(dto.name, dto.note);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateChannelGroupDto) {
    return this.channels.updateGroup(id, dto);
  }

  /** 删除分组不会删账号，组内通道会变成未分组 */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.channels.removeGroup(id);
  }
}
