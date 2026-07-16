import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

class InviteUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(6)
  password: string;
}

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  list(@CurrentUser('tenantId') tenantId: string) {
    return this.userService.listByTenant(tenantId);
  }

  @Post('invite')
  invite(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: InviteUserDto,
  ) {
    return this.userService.invite(tenantId, dto);
  }
}
