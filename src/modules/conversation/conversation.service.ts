import { Injectable, NotFoundException } from '@nestjs/common';
import { ChannelType, ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ContactService } from '../contact/contact.service';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contactService: ContactService,
  ) {}

  async list(
    tenantId: string,
    filters: {
      status?: ConversationStatus;
      assignedToId?: string;
      channelType?: ChannelType;
      search?: string;
      mine?: string;
      userId?: string;
    },
  ) {
    const search = filters.search?.trim();
    const conversations = await this.prisma.conversation.findMany({
      where: {
        tenantId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
        ...(filters.channelType ? { channelType: filters.channelType } : {}),
        ...(filters.mine === 'true' && filters.userId
          ? { assignedToId: filters.userId }
          : {}),
        ...(search
          ? {
              OR: [
                {
                  contact: {
                    OR: [
                      { name: { contains: search } },
                      { phone: { contains: search } },
                    ],
                  },
                },
                {
                  messages: {
                    some: { body: { contains: search } },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        channelConn: { select: { id: true, name: true, type: true, status: true } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    if (!search) return conversations;

    const convIds = conversations.map((c) => c.id);
    if (convIds.length === 0) return conversations;

    const matchingMessages = await this.prisma.message.findMany({
      where: {
        conversationId: { in: convIds },
        body: { contains: search },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        conversationId: true,
        body: true,
        contentType: true,
        mediaUrl: true,
        direction: true,
        createdAt: true,
      },
    });

    const latestMatchByConv = new Map<string, (typeof matchingMessages)[number]>();
    for (const msg of matchingMessages) {
      if (!latestMatchByConv.has(msg.conversationId)) {
        latestMatchByConv.set(msg.conversationId, msg);
      }
    }

    return conversations.map((conv) => {
      const match = latestMatchByConv.get(conv.id);
      if (!match) return conv;
      const { conversationId: _, ...message } = match;
      return { ...conv, messages: [message] };
    });
  }

  async findById(tenantId: string, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        channelConn: true,
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /**
   * Concurrent inbound messages from the same chat used to race the
   * find-then-create below and produce duplicate conversations, so calls
   * are serialized per (contact, channel) key.
   */
  private pending = new Map<string, Promise<unknown>>();

  async findOrCreateConversation(
    tenantId: string,
    data: {
      channelConnId: string;
      channelType: ChannelType;
      contactId: string;
      readOnly?: boolean;
    },
  ) {
    const key = `${tenantId}:${data.contactId}:${data.channelConnId}`;
    const prev = this.pending.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.doFindOrCreateConversation(tenantId, data));
    this.pending.set(key, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(key) === run) this.pending.delete(key);
    }
  }

  private async doFindOrCreateConversation(
    tenantId: string,
    data: {
      channelConnId: string;
      channelType: ChannelType;
      contactId: string;
      readOnly?: boolean;
    },
  ) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        tenantId,
        contactId: data.contactId,
        channelConnId: data.channelConnId,
      },
    });
    if (existing) {
      // Admin-only status of a group can change over time; keep it in sync.
      if (data.readOnly !== undefined && existing.readOnly !== data.readOnly) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: { readOnly: data.readOnly },
        });
      }
      return existing;
    }

    return this.prisma.conversation.create({
      data: {
        tenantId,
        contactId: data.contactId,
        channelConnId: data.channelConnId,
        channelType: data.channelType,
        readOnly: data.readOnly ?? false,
      },
    });
  }

  async update(
    tenantId: string,
    id: string,
    data: { status?: ConversationStatus; assignedToId?: string | null },
  ) {
    await this.findById(tenantId, id);
    return this.prisma.conversation.update({
      where: { id },
      data,
      include: {
        contact: true,
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async incrementUnread(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });
  }

  async resetUnread(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });
  }

  /** Wipe every conversation (messages cascade); contacts and channels stay. */
  async clearAll(tenantId: string) {
    const result = await this.prisma.conversation.deleteMany({
      where: { tenantId },
    });
    return { deleted: result.count };
  }

  async getStats(tenantId: string) {
    const [open, pending, resolved, totalMessages] = await Promise.all([
      this.prisma.conversation.count({ where: { tenantId, status: 'open' } }),
      this.prisma.conversation.count({ where: { tenantId, status: 'pending' } }),
      this.prisma.conversation.count({ where: { tenantId, status: 'resolved' } }),
      this.prisma.message.count({
        where: {
          conversation: { tenantId },
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);
    return { open, pending, resolved, todayMessages: totalMessages };
  }
}
