import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateChannelDto {
  @IsString()
  @MinLength(1, { message: '请填写通道名称' })
  @MaxLength(64)
  name: string;

  @IsString()
  @MinLength(1, { message: '请填写 SMTP 服务器' })
  @MaxLength(255)
  host: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  @Type(() => Number)
  port: number;

  @IsBoolean()
  secure: boolean;

  @IsString()
  @MinLength(1, { message: '请填写 SMTP 用户名' })
  @MaxLength(255)
  username: string;

  @IsString()
  @MinLength(1, { message: '请填写密码或授权码' })
  @MaxLength(512)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  fromName?: string;

  @IsEmail({}, { message: '发信地址不是合法邮箱' })
  fromEmail: string;

  @IsOptional()
  @IsEmail({}, { message: '回复地址不是合法邮箱' })
  replyTo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  @Type(() => Number)
  dailyLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  minIntervalSec?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  priority?: number;
}

export class UpdateChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '请填写通道名称' })
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: '请填写 SMTP 服务器' })
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Type(() => Number)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: '请填写 SMTP 用户名' })
  @MaxLength(255)
  username?: string;

  /** 留空表示不改密码 */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  fromName?: string;

  @IsOptional()
  @IsEmail()
  fromEmail?: string;

  @IsOptional()
  @IsString()
  replyTo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  @Type(() => Number)
  dailyLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  @Type(() => Number)
  minIntervalSec?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  groupIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  priority?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

/**
 * 测试连接：可以只传 id（用已存的密码），也可以传完整配置。
 * 后者用于"新增账号时先测通再保存"，避免存进去一堆连不上的账号。
 */
export class TestConnectionDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Type(() => Number)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;
}

export class TestSendDto {
  @IsEmail({}, { message: '收件地址不是合法邮箱' })
  to: string;
}
