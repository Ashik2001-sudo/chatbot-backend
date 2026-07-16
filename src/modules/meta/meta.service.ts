import { Injectable, Inject, forwardRef } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelService } from '../channel/channel.service';
import { MessageService } from '../message/message.service';

type MetaConversation = {
  channelConnId: string;
  contact: {
    externalIds: unknown;
  };
};

@Injectable()
export class MetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channelService: ChannelService,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
  ) {}

  async handleWebhook(body: Record<string, unknown>) {
    const entry = (body.entry as Array<Record<string, unknown>>) ?? [];
    for (const e of entry) {
      const messaging = (e.messaging as Array<Record<string, unknown>>) ?? [];
      for (const event of messaging) {
        await this.processMessengerEvent(event);
      }
    }
  }

  private async processMessengerEvent(event: Record<string, unknown>) {
    const sender = event.sender as { id: string };
    const recipient = event.recipient as { id: string };
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !sender?.id) return;

    // Echo = the page itself replied (from another device/app): sender is the
    // page and recipient is the customer, the opposite of a normal message.
    const isEcho = Boolean(message.is_echo);
    const channelExternalId = isEcho ? sender.id : recipient.id;
    const partnerId = isEcho ? recipient.id : sender.id;

    const channel = await this.channelService.findByExternalId(channelExternalId);
    if (!channel) return;

    const attachments = message.attachments as
      | Array<{ type: string; payload?: { url?: string } }>
      | undefined;

    let contentType: 'text' | 'image' | 'audio' | 'video' | 'document' = 'text';
    let mediaUrl: string | undefined;
    let body = (message.text as string | undefined) ?? '';

    if (attachments?.length) {
      const att = attachments[0];
      mediaUrl = att.payload?.url;
      if (att.type === 'image' || att.type === 'sticker') contentType = 'image';
      else if (att.type === 'video') contentType = 'video';
      else if (att.type === 'audio') contentType = 'audio';
      else contentType = 'document';
    } else if (!body && message.sticker_id) {
      body = '[sticker]';
    }

    const profile = await this.fetchSenderProfile(
      partnerId,
      (channel.credentials as { accessToken?: string })?.accessToken,
      channel.type === 'INSTAGRAM',
    );

    await this.messageService.createInbound({
      tenantId: channel.tenantId,
      channelConnId: channel.id,
      channelType: channel.type,
      direction: isEcho ? 'outbound' : 'inbound',
      contact: {
        name: profile.name ?? partnerId,
        avatarUrl: profile.avatarUrl,
        externalIds: {
          facebook: partnerId,
          ...(channel.type === 'INSTAGRAM' ? { instagram: partnerId } : {}),
        },
      },
      message: {
        body,
        contentType,
        mediaUrl,
        externalId: message.mid as string,
      },
    });
  }

  private async fetchSenderProfile(
    senderId: string,
    accessToken: string | undefined,
    isInstagram: boolean,
  ): Promise<{ name?: string; avatarUrl?: string }> {
    if (!accessToken) return {};
    try {
      const fields = isInstagram
        ? 'name,username,profile_pic'
        : 'first_name,last_name,profile_pic';
      const { data } = await axios.get<{
        first_name?: string;
        last_name?: string;
        name?: string;
        username?: string;
        profile_pic?: string;
      }>(`https://graph.facebook.com/v21.0/${senderId}`, {
        params: { fields, access_token: accessToken },
      });

      const name =
        data.name ??
        data.username ??
        [data.first_name, data.last_name].filter(Boolean).join(' ') ??
        undefined;

      return { name: name || undefined, avatarUrl: data.profile_pic };
    } catch {
      return {};
    }
  }

  async sendOutbound(
    conversation: MetaConversation,
    body: string,
    mediaUrl?: string,
    contentType?: string,
  ) {
    const externalIds = conversation.contact.externalIds as Record<
      string,
      string
    >;
    const psid = externalIds?.facebook ?? externalIds?.instagram;
    if (!psid) return;

    const channel = await this.prisma.channelConnection.findUnique({
      where: { id: conversation.channelConnId },
    });
    if (!channel) return;

    const creds = channel.credentials as { accessToken: string };
    const endpoint = 'https://graph.facebook.com/v21.0/me/messages';
    const params = { access_token: creds.accessToken };

    if (mediaUrl) {
      // Meta must be able to fetch the file, so local uploads need a public base URL.
      const url = mediaUrl.startsWith('/')
        ? `${process.env.PUBLIC_URL ?? 'http://localhost:4001'}${mediaUrl}`
        : mediaUrl;
      const type =
        contentType === 'document'
          ? 'file'
          : contentType === 'video' || contentType === 'audio'
            ? contentType
            : 'image';

      await axios.post(
        endpoint,
        {
          recipient: { id: psid },
          message: {
            attachment: { type, payload: { url, is_reusable: true } },
          },
        },
        { params },
      );
    }

    if (body) {
      await axios.post(
        endpoint,
        { recipient: { id: psid }, message: { text: body } },
        { params },
      );
    }
  }
}
