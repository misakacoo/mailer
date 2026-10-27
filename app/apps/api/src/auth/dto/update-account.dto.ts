import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAccountDto {
  /** 新账号；不传表示不改 */
  @IsOptional()
  @IsString()
  @MinLength(3, { message: '账号至少 3 位' })
  @MaxLength(120)
  account?: string;

  /** 新密码；不传表示不改密码 */
  @IsOptional()
  @IsString()
  @MinLength(6, { message: '新密码至少 6 位' })
  @MaxLength(200)
  newPassword?: string;

  /** 当前密码，必填：防止拿到已登录浏览器的人直接顶掉管理员 */
  @IsString()
  @MinLength(1, { message: '请输入当前密码' })
  @MaxLength(200)
  currentPassword: string;
}
