import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MessageService } from './message.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { MessageContentType } from '@prisma/client';

class SendMessageDto {
  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @IsOptional()
  @IsIn(['text', 'image', 'audio', 'video', 'document'])
  contentType?: MessageContentType;
}

@Controller('conversations/:conversationId/messages')
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @Get()
  list(
    @CurrentUser('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messageService.list(
      conversationId,
      tenantId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Post()
  send(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messageService.sendReply(
      tenantId,
      conversationId,
      userId,
      dto.body ?? '',
      dto.mediaUrl,
      dto.contentType,
    );
  }

  @Post('read')
  markRead(
    @CurrentUser('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messageService.markConversationRead(tenantId, conversationId);
  }
}
