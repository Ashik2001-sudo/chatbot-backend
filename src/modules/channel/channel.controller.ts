import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ChannelService } from './channel.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { ConversationService } from '../conversation/conversation.service';

class MetaChannelDto {
  @IsString()
  name: string;

  @IsString()
  pageId: string;

  @IsString()
  accessToken: string;

  @IsOptional()
  @IsString()
  instagramId?: string;
}

class CloudWhatsAppDto {
  @IsString()
  name: string;

  @IsString()
  phoneNumberId: string;

  @IsString()
  accessToken: string;
}

class BaileysDto {
  @IsString()
  name: string;
}

class HistorySyncDecisionDto {
  @IsBoolean()
  enabled: boolean;
}

@Controller('channels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class ChannelController {
  constructor(
    private readonly channelService: ChannelService,
    private readonly whatsAppService: WhatsAppService,
    private readonly conversationService: ConversationService,
  ) {}

  @Get()
  list(@CurrentUser('tenantId') tenantId: string) {
    return this.channelService.list(tenantId);
  }

  @Post('whatsapp/baileys')
  async connectBaileys(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: BaileysDto,
  ) {
    // Old QR attempts that were never scanned would otherwise pile up.
    await this.whatsAppService.cleanupStalePendingChannels(tenantId);
    await this.channelService.requireNoActive(
      tenantId,
      ['WHATSAPP_BAILEYS', 'WHATSAPP_CLOUD'],
      'WhatsApp',
    );

    // Reconnecting must reuse the existing channel row; a new row per scan
    // would duplicate every conversation (they're keyed per channel).
    const channels = await this.channelService.list(tenantId);
    const existing = channels.find(
      (c) => c.type === 'WHATSAPP_BAILEYS' && c.status !== 'connected',
    );

    const channel = existing
      ? await this.channelService.updateStatus(existing.id, 'pending_qr')
      : await this.channelService.create(tenantId, {
          type: 'WHATSAPP_BAILEYS',
          name: dto.name,
          status: 'pending_qr',
        });

    await this.whatsAppService.startBaileysSession(tenantId, channel.id);
    return { success: true, data: channel };
  }

  @Post('reset-inbox')
  async resetInbox(@CurrentUser('tenantId') tenantId: string) {
    const channels = await this.channelService.list(tenantId);
    const activeChannels = channels.filter(
      (channel) => channel.status !== 'disconnected',
    );
    if (activeChannels.length) {
      throw new BadRequestException(
        'Disconnect all channels before resetting the inbox.',
      );
    }

    const result = await this.conversationService.clearAll(tenantId);
    return {
      success: true,
      deletedConversations: result.deleted,
    };
  }

  @Post(':id/disconnect')
  async disconnectChannel(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    const channel = await this.channelService.findById(tenantId, id);
    if (channel.type === 'WHATSAPP_BAILEYS') {
      // Log out and wipe stored credentials; conversations stay intact.
      this.whatsAppService.removeBaileysSession(id);
    }
    await this.channelService.updateStatus(id, 'disconnected');
    return { success: true };
  }

  @Post(':id/history-sync')
  async chooseHistorySync(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: HistorySyncDecisionDto,
  ) {
    await this.channelService.findById(tenantId, id);
    await this.whatsAppService.setHistorySyncDecision(id, dto.enabled);
    return { success: true };
  }

  @Post('whatsapp/cloud')
  async connectCloud(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: CloudWhatsAppDto,
  ) {
    await this.channelService.requireNoActive(
      tenantId,
      ['WHATSAPP_BAILEYS', 'WHATSAPP_CLOUD'],
      'WhatsApp',
    );
    const channel = await this.channelService.create(tenantId, {
      type: 'WHATSAPP_CLOUD',
      name: dto.name,
      externalId: dto.phoneNumberId,
      status: 'connected',
      credentials: {
        phoneNumberId: dto.phoneNumberId,
        accessToken: dto.accessToken,
      },
    });
    return { success: true, data: channel };
  }

  @Post('meta')
  async connectMeta(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: MetaChannelDto,
  ) {
    await this.channelService.requireNoActive(
      tenantId,
      ['FACEBOOK_PAGE'],
      'Facebook',
    );
    if (dto.instagramId) {
      await this.channelService.requireNoActive(
        tenantId,
        ['INSTAGRAM'],
        'Instagram',
      );
    }

    const fb = await this.channelService.create(tenantId, {
      type: 'FACEBOOK_PAGE',
      name: `${dto.name} (Facebook)`,
      externalId: dto.pageId,
      status: 'connected',
      credentials: { pageId: dto.pageId, accessToken: dto.accessToken },
    });

    let ig = null;
    if (dto.instagramId) {
      ig = await this.channelService.create(tenantId, {
        type: 'INSTAGRAM',
        name: `${dto.name} (Instagram)`,
        externalId: dto.instagramId,
        status: 'connected',
        credentials: {
          instagramId: dto.instagramId,
          accessToken: dto.accessToken,
        },
      });
    }

    return { success: true, data: { facebook: fb, instagram: ig } };
  }

  @Delete(':id')
  async remove(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    this.whatsAppService.removeBaileysSession(id);
    await this.channelService.remove(tenantId, id);
    return { success: true };
  }
}
