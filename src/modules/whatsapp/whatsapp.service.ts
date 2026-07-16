import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { BaileysProvider } from './providers/baileys.provider';
import { WhatsAppCloudProvider } from './providers/cloud-api.provider';
import { ChannelService } from '../channel/channel.service';
import { MessageService } from '../message/message.service';

type ConversationWithContact = {
  tenantId: string;
  channelConnId: string;
  contact: {
    phone?: string | null;
    externalIds?: unknown;
  };
};

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly baileysProvider: BaileysProvider,
    private readonly cloudProvider: WhatsAppCloudProvider,
    private readonly channelService: ChannelService,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
  ) {}

  async onModuleInit() {
    const channels = await this.channelService.findAllByType('WHATSAPP_BAILEYS');
    for (const channel of channels) {
      if (!this.baileysProvider.hasSavedSession(channel.id)) continue;
      this.logger.log(`Restoring Baileys session for channel ${channel.id}`);
      // allowPairing false: restores must never start a QR flow on their own.
      this.startBaileysSession(channel.tenantId, channel.id, false).catch(
        (err) =>
          this.logger.error(
            `Failed to restore Baileys session ${channel.id}: ${err.message}`,
          ),
      );
    }
  }

  async startBaileysSession(
    tenantId: string,
    channelId: string,
    allowPairing = true,
  ) {
    await this.baileysProvider.startSession(
      tenantId,
      channelId,
      (data) => this.messageService.createInbound(data),
      { allowPairing },
    );
  }

  disconnectBaileys(channelId: string) {
    this.baileysProvider.disconnect(channelId);
  }

  /** Disconnect and delete stored session credentials (channel removal). */
  removeBaileysSession(channelId: string) {
    this.baileysProvider.removeSession(channelId);
  }

  /** Delete QR attempts that were never scanned, so they don't pile up. */
  async cleanupStalePendingChannels(tenantId: string) {
    const stale = await this.channelService.listStalePendingBaileys(tenantId);
    for (const channel of stale) {
      this.baileysProvider.removeSession(channel.id);
      // Channels that already collected conversations must never be deleted
      // (that would cascade-delete the messages); just mark them offline.
      if (channel._count.conversations > 0) {
        await this.channelService.updateStatus(channel.id, 'disconnected');
        this.logger.log(`Reset stale pending channel ${channel.id}`);
      } else {
        await this.channelService.remove(tenantId, channel.id);
        this.logger.log(`Removed stale pending channel ${channel.id}`);
      }
    }
  }

  setHistorySyncDecision(channelId: string, enabled: boolean) {
    return this.baileysProvider.setHistorySyncDecision(channelId, enabled);
  }

  async sendOutbound(
    conversation: ConversationWithContact,
    body: string,
    mediaUrl?: string,
    contentType?: string,
  ) {
    const channel = await this.channelService.findById(
      conversation.tenantId,
      conversation.channelConnId,
    );

    const externalIds = conversation.contact.externalIds as Record<string, string> | undefined;
    const phone = conversation.contact.phone ?? externalIds?.whatsapp;

    if (!phone) return;

    if (channel.type === 'WHATSAPP_BAILEYS') {
      await this.baileysProvider.sendMessage(
        channel.id,
        phone,
        body,
        mediaUrl,
        contentType,
      );
    } else if (channel.type === 'WHATSAPP_CLOUD') {
      await this.cloudProvider.sendMessage(
        channel,
        phone,
        body,
        mediaUrl,
        contentType,
      );
    }
  }
}
