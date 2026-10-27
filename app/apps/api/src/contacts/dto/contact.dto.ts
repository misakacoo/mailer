import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
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
