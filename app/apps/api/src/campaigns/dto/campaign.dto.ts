import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** 一个 A/B 变体：标签 + 可选的覆盖项。两者都为空等于和主模板一模一样。 */
export class CampaignVariantDto {
  @IsString()
  @Matches(/^[A-Z][0-9]?$/, { message: '变体标签只能是 A、B、C 这样的单字母（可带一位序号）' })
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  templateId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  weight?: number;
}

export class CreateCampaignDto {
  @IsString()
  @MinLength(1, { message: '请填写任务名称' })
  @MaxLength(64)
  name: string;

  @IsInt()
  @Type(() => Number)
  templateId: number;

  @IsArray()
  @ArrayNotEmpty({ message: '至少选择一个分组' })
  @IsInt({ each: true })
  @Type(() => Number)
  listIds: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  channelIds?: number[];

  /** 按发件分组选号；非空时优先于 channelIds */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  channelGroupIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  sendIntervalSec?: number;

  /** 最大发送间隔：填了就在 [最小, 最大] 之间随机，不填等于固定最小间隔 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  sendIntervalMaxSec?: number;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  /** none = 一次性；daily/weekly/monthly = 周期任务 */
  @IsOptional()
  @IsIn(['none', 'daily', 'weekly', 'monthly'], { message: '周期只支持每天/每周/每月' })
  recurrence?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  @Type(() => Number)
  recurrenceInterval?: number;

  @IsOptional()
  @IsDateString()
  recurrenceUntil?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: '最多 3 个变体' })
  @ValidateNested({ each: true })
  @Type(() => CampaignVariantDto)
  variants?: CampaignVariantDto[];
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  templateId?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  listIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  channelIds?: number[];

  /** 按发件分组选号；非空时优先于 channelIds */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  channelGroupIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  sendIntervalSec?: number;

  /** 最大发送间隔：填了就在 [最小, 最大] 之间随机，不填等于固定最小间隔 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  sendIntervalMaxSec?: number;

  @IsOptional()
  @IsIn(['none', 'daily', 'weekly', 'monthly'], { message: '周期只支持每天/每周/每月' })
  recurrence?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  @Type(() => Number)
  recurrenceInterval?: number;

  @IsOptional()
  @IsDateString()
  recurrenceUntil?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: '最多 3 个变体' })
  @ValidateNested({ each: true })
  @Type(() => CampaignVariantDto)
  variants?: CampaignVariantDto[];
}

/** 排期：把草稿挂到一个未来的时间点，由 worker 到点自动开跑 */
export class ScheduleCampaignDto {
  @IsDateString({}, { message: '发送时间格式不正确' })
  scheduledAt: string;
}

export class QueryRecipientsDto {
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
  status?: string;
}
