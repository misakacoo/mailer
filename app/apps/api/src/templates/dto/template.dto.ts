import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @MinLength(1, { message: '请填写模板名称' })
  @MaxLength(64)
  name: string;

  @IsString()
  @MinLength(1, { message: '请填写邮件主题' })
  @MaxLength(255)
  subject: string;

  @IsString()
  html: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  trackOpen?: boolean;

  @IsOptional()
  @IsBoolean()
  trackClick?: boolean;

  @IsOptional()
  @IsArray()
  attachmentIds?: number[];
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsString()
  html?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  trackOpen?: boolean;

  @IsOptional()
  @IsBoolean()
  trackClick?: boolean;

  @IsOptional()
  @IsArray()
  attachmentIds?: number[];
}

export class SampleContactDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  fields?: Record<string, string>;
}

export class PreviewDto {
  @IsString()
  subject: string;

  @IsString()
  html: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  trackOpen?: boolean;

  @IsOptional()
  @IsBoolean()
  trackClick?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => SampleContactDto)
  sample?: SampleContactDto;
}

export class TestSendTemplateDto {
  @IsInt()
  @Type(() => Number)
  channelId: number;

  @IsString()
  @MinLength(3)
  to: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SampleContactDto)
  sample?: SampleContactDto;
}
