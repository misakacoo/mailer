import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateListDto {
  @IsString()
  @MinLength(1, { message: '请填写分组名称' })
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class UpdateListDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
