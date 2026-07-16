import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ChannelService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.channelConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requireNoActive(
    tenantId: string,
    types: ChannelType[],
    label: string,
  ) {
    const existing = await this.prisma.channelConnection.findFirst({
      where: {
        tenantId,
        type: { in: types },
        status: { not: 'disconnected' },
      },
      select: { id: true, name: true, status: true },
    });
    if (existing) {
      throw new BadRequestException(
        `${label} is already connected. Disconnect "${existing.name}" before adding another one.`,
      );
    }
  }

  async create(
    tenantId: string,
    data: {
      type: ChannelType;
      name: string;
      credentials?: Record<string, unknown>;
      externalId?: string;
      status?: 'connected' | 'disconnected' | 'pending_qr';
    },
  ) {
    return this.prisma.channelConnection.create({
      data: {
        tenantId,
        type: data.type,
        name: data.name,
        credentials: (data.credentials ?? {}) as Prisma.InputJsonValue,
        externalId: data.externalId,
        status: data.status ?? 'disconnected',
      },
    });
  }

  async findById(tenantId: string, id: string) {
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id, tenantId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  async updateStatus(
    id: string,
    status: 'connected' | 'disconnected' | 'pending_qr',
    credentials?: Record<string, unknown>,
  ) {
    return this.prisma.channelConnection.update({
      where: { id },
      data: {
        status,
        ...(credentials ? { credentials: credentials as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findById(tenantId, id);
    return this.prisma.channelConnection.delete({ where: { id } });
  }

  findAllByType(type: ChannelType) {
    return this.prisma.channelConnection.findMany({ where: { type } });
  }

  /** Abandoned QR attempts that never finished pairing. */
  listStalePendingBaileys(tenantId: string) {
    return this.prisma.channelConnection.findMany({
      where: { tenantId, type: 'WHATSAPP_BAILEYS', status: 'pending_qr' },
      include: { _count: { select: { conversations: true } } },
    });
  }

  findByExternalId(externalId: string) {
    return this.prisma.channelConnection.findFirst({
      where: { externalId },
      include: { tenant: true },
    });
  }
}
