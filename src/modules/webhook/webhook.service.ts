import { Injectable } from '@nestjs/common';
import { ChannelService } from '../channel/channel.service';
import { MessageService } from '../message/message.service';

@Injectable()
export class WebhookService {
  constructor(
    private readonly channelService: ChannelService,
    private readonly messageService: MessageService,
  ) {}

  async handleWhatsAppCloudWebhook(body: Record<string, unknown>) {
    const entries = (body.entry as Array<Record<string, unknown>>) ?? [];
    for (const entry of entries) {
      const changes = (entry.changes as Array<Record<string, unknown>>) ?? [];
      for (const change of changes) {
        const value = change.value as Record<string, unknown>;
        const messages = (value?.messages as Array<Record<string, unknown>>) ?? [];
        const metadata = value?.metadata as { phone_number_id?: string };
        const contacts =
          (value?.contacts as Array<{
            wa_id?: string;
            profile?: { name?: string };
          }>) ?? [];

        for (const msg of messages) {
          const phoneNumberId = metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          const channel = await this.channelService.findByExternalId(phoneNumberId);
          if (!channel) continue;

          const from = msg.from as string;
          const type = msg.type as string;
          const profileName = contacts.find((c) => c.wa_id === from)?.profile
            ?.name;
          let body = '';
          let contentType: 'text' | 'image' | 'audio' | 'document' = 'text';

          if (type === 'text') {
            body = (msg.text as { body: string }).body;
          } else if (type === 'image') {
            contentType = 'image';
            body = (msg.image as { caption?: string })?.caption ?? '';
          } else if (type === 'audio') {
            contentType = 'audio';
            body = '[audio]';
          } else if (type === 'document') {
            contentType = 'document';
            body = (msg.document as { filename?: string })?.filename ?? '[document]';
          }

          await this.messageService.createInbound({
            tenantId: channel.tenantId,
            channelConnId: channel.id,
            channelType: 'WHATSAPP_CLOUD',
            contact: {
              name: profileName,
              phone: from,
              externalIds: { whatsapp: from },
            },
            message: {
              body,
              contentType,
              externalId: msg.id as string,
            },
          });
        }
      }
    }
  }
}
