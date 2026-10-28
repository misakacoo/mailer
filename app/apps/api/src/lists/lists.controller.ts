import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateListDto, UpdateListDto } from './dto/list.dto';
import { ListsService } from './lists.service';

@UseGuards(JwtAuthGuard)
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  findAll() {
    return this.lists.findAll();
  }

  @Post()
  create(@Body() dto: CreateListDto) {
    return this.lists.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateListDto) {
    return this.lists.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.lists.remove(id);
  }

  /** 清空分组：删掉组内联系人，分组本身保留 */
  @Post(':id/clear')
  clear(@Param('id', ParseIntPipe) id: number) {
    return this.lists.clear(id);
  }
}
