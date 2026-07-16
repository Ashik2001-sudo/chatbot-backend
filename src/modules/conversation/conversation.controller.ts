import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ConversationStatus, ChannelType } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

class UpdateConversationDto {
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @IsOptional()
  @IsString()
  assignedToId?: string | null;
}

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get('stats')
  stats(@CurrentUser('tenantId') tenantId: string) {
    return this.conversationService.getStats(tenantId);
  }

  @Get()
  list(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
    @Query('status') status?: ConversationStatus,
    @Query('assignedToId') assignedToId?: string,
    @Query('channelType') channelType?: ChannelType,
    @Query('search') search?: string,
    @Query('mine') mine?: string,
  ) {
    return this.conversationService.list(tenantId, {
      status,
      assignedToId,
      channelType,
      search,
      mine,
      userId,
    });
  }

  @Get(':id')
  getOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.conversationService.findById(tenantId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversationService.update(tenantId, id, dto);
  }
}
