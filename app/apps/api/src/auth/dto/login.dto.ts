import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /**
   * 登录账号。默认是 admin，也允许填邮箱——
   * 所以这里不能用 @IsEmail，否则发出去的默认账号根本登不进来。
   */
  @IsString()
  @MinLength(1, { message: '请输入账号' })
  @MaxLength(120)
  account: string;

  @IsString()
  @MinLength(1, { message: '请输入密码' })
  @MaxLength(200)
  password: string;
}
