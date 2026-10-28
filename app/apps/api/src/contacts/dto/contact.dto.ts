import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class QueryContactsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  listId?: number;
}

/** 批量设置分组：replace=true 表示先清空这些人原有的其他分组 */
export class BatchSetListsDto {
  @IsArray()
  @ArrayMaxSize(500, { message: '一次最多调整 500 个联系人' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  ids: number[];

  @IsArray()
  @ArrayMaxSize(100, { message: '一次最多选 100 个分组' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  listIds: number[];

  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

/** 批量删除联系人；邮箱侧的抑制记录一并清掉，否则重新导入还会被拦截 */
export class BatchDeleteContactsDto {
  @IsArray()
  @ArrayMaxSize(500, { message: '一次最多删除 500 个联系人' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  ids: number[];
}

export class CreateContactDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsObject()
  fields?: Record<string, string>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  listId?: number;
}

export class UpdateContactDto {
  /** 允许改邮箱，但会校验格式、长度、唯一性，且不能改成抑制名单里的地址 */
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;


  @IsOptional()
  @IsObject()
  fields?: Record<string, string>;
}

/** 替换某个联系人的分组归属；传空数组表示移出所有分组 */
export class SetContactListsDto {
  @IsArray()
  @ArrayMaxSize(100, { message: '一次最多选 100 个分组' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Type(() => Number)
  listIds: number[];
}

export class ExtraColumnDto {
  @IsInt()
  @Type(() => Number)
  index: number;

  @IsString()
  @MaxLength(64)
  key: string;
}

export class ColumnMappingDto {
  @IsInt()
  @Min(0)
  @Type(() => Number)
  emailColumn: number;

  @IsOptional()
  @Type(() => Number)
  nameColumn?: number | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtraColumnDto)
  extraColumns?: ExtraColumnDto[];
}

export class CommitImportDto {
  @IsString()
  token: string;

  @IsInt()
  @Type(() => Number)
  listId: number;

  @IsObject()
  @ValidateNested()
  @Type(() => ColumnMappingDto)
  mapping: ColumnMappingDto;
}
