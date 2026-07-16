import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ChannelConnection } from '@prisma/client';

@Injectable()
export class WhatsAppCloudProvider {
  async sendMessage(
    channel: ChannelConnection,
    to: string,
    body: string,
    mediaUrl?: string,
    contentType?: string,
  ) {
    const creds = channel.credentials as {
      phoneNumberId: string;
      accessToken: string;
    };
    const phone = to.replace(/\D/g, '');

    // Meta servers must be able to fetch the media, so local paths need a public base URL.
    const link = mediaUrl?.startsWith('/')
      ? `${process.env.PUBLIC_URL ?? 'http://localhost:4001'}${mediaUrl}`
      : mediaUrl;

    let payload: Record<string, unknown>;
    if (!link) {
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body },
      };
    } else if (contentType === 'video') {
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'video',
        video: { link, caption: body },
      };
    } else if (contentType === 'audio') {
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'audio',
        audio: { link },
      };
    } else if (contentType === 'document') {
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'document',
        document: { link, caption: body },
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: { link, caption: body },
      };
    }

    await axios.post(
      `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
  }
}
