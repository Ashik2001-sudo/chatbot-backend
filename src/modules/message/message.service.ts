import {
  BadRequestException,
  Injectable,
  Inject,
  forwardRef,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelType,
  MessageContentType,
  MessageDirection,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../conversation/conversation.service';
import { ContactService } from '../contact/contact.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MetaService } from '../meta/meta.service';

export interface InboundMessageInput {
  tenantId: string;
  channelConnId: string;
  channelType: ChannelType;
  /** 'outbound' when the business replied from another device (echo). */
  direction?: MessageDirection;
  /**
   * True for messages imported during history sync: keeps original
   * timestamps, skips unread counters and per-message realtime events.
   */
  history?: boolean;
  conversationMeta?: {
    /** Announce-only group where we can't send (composer disabled). */
    readOnly?: boolean;
  };
  contact: {
    name?: string;
    phone?: string;
    avatarUrl?: string;
    externalIds?: Record<string, string>;
  };
  message: {
    body?: string;
    contentType?: MessageContentType;
    mediaUrl?: string;
    externalId?: string;
    /** Original send time (used for history sync). */
    timestamp?: Date;
  };
}

@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationService: ConversationService,
    private readonly contactService: ContactService,
    private readonly realtimeGateway: RealtimeGateway,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsAppService: WhatsAppService,
    @Inject(forwardRef(() => MetaService))
    private readonly metaService: MetaService,
  ) {}

  list(conversationId: string, tenantId: string, page = 1, limit = 50) {
    return this.prisma.message.findMany({
      where: { conversationId, conversation: { tenantId } },
      include: {
        sentBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async createInbound(input: InboundMessageInput) {
    const direction = input.direction ?? 'inbound';

    // Channels can echo the same message multiple times (multi-device, retries).
    if (input.message.externalId) {
      const existing = await this.prisma.message.findFirst({
        where: {
          externalId: input.message.externalId,
          conversation: { tenantId: input.tenantId },
        },
      });
      if (existing) return null;
    }

    const contact = await this.contactService.findOrCreate(input.tenantId, input.contact);
    const conversation = await this.conversationService.findOrCreateConversation(
      input.tenantId,
      {
        channelConnId: input.channelConnId,
        channelType: input.channelType,
        contactId: contact.id,
        readOnly: input.conversationMeta?.readOnly,
      },
    );

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction,
        contentType: input.message.contentType ?? 'text',
        body: input.message.body,
        mediaUrl: input.message.mediaUrl,
        externalId: input.message.externalId,
        status: direction === 'inbound' ? 'delivered' : 'sent',
        ...(input.message.timestamp
          ? { createdAt: input.message.timestamp }
          : {}),
      },
      include: {
        sentBy: { select: { id: true, name: true } },
      },
    });

    if (input.history) {
      // Old imported messages must not bump unread counters or reorder
      // the inbox past their original time.
      const ts = input.message.timestamp;
      if (ts && ts > conversation.lastMessageAt) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: ts },
        });
      }
      return { message, conversation: null };
    }

    if (direction === 'inbound') {
      await this.conversationService.incrementUnread(conversation.id);
    } else {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    const fullConversation = await this.conversationService.findById(
      input.tenantId,
      conversation.id,
    );

    this.realtimeGateway.emitNewMessage(input.tenantId, {
      message,
      conversation: fullConversation,
    });

    return { message, conversation: fullConversation };
  }

  async sendReply(
    tenantId: string,
    conversationId: string,
    userId: string,
    body: string,
    mediaUrl?: string,
    contentType?: MessageContentType,
  ) {
    const conversation = await this.conversationService.findById(
      tenantId,
      conversationId,
    );

    if (conversation.readOnly) {
      throw new BadRequestException(
        'Only admins can send messages in this group.',
      );
    }

    const resolvedType: MessageContentType = mediaUrl
      ? (contentType ?? 'image')
      : 'text';

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: 'outbound',
        contentType: resolvedType,
        body,
        mediaUrl,
        sentById: userId,
        status: 'sent',
      },
      include: {
        sentBy: { select: { id: true, name: true } },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    if (
      conversation.channelType === 'WHATSAPP_BAILEYS' ||
      conversation.channelType === 'WHATSAPP_CLOUD'
    ) {
      await this.whatsAppService.sendOutbound(
        {
          tenantId,
          channelConnId: conversation.channelConnId,
          contact: conversation.contact,
        },
        body,
        mediaUrl,
        resolvedType,
      );
    } else if (
      conversation.channelType === 'FACEBOOK_PAGE' ||
      conversation.channelType === 'INSTAGRAM'
    ) {
      await this.metaService.sendOutbound(
        conversation,
        body,
        mediaUrl,
        resolvedType,
      );
    }

    this.realtimeGateway.emitNewMessage(tenantId, {
      message,
      conversation,
    });

    return message;
  }

  async markConversationRead(tenantId: string, conversationId: string) {
    await this.conversationService.findById(tenantId, conversationId);
    await this.conversationService.resetUnread(conversationId);
    return { success: true };
  }
}
