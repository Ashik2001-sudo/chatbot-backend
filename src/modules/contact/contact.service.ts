import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ContactService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string, search?: string) {
    return this.prisma.contact.findMany({
      where: {
        tenantId,
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { phone: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        conversations: {
          take: 1,
          orderBy: { lastMessageAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Concurrent inbound messages from the same sender used to race the
   * find-then-create below and produce duplicate contacts, so calls are
   * serialized per contact key.
   */
  private pending = new Map<string, Promise<unknown>>();

  async findOrCreate(
    tenantId: string,
    data: {
      name?: string;
      phone?: string;
      avatarUrl?: string;
      externalIds?: Record<string, string>;
    },
  ) {
    const key = `${tenantId}:${data.phone ?? JSON.stringify(data.externalIds ?? {})}`;
    const prev = this.pending.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.doFindOrCreate(tenantId, data));
    this.pending.set(key, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(key) === run) this.pending.delete(key);
    }
  }

  private async doFindOrCreate(
    tenantId: string,
    data: {
      name?: string;
      phone?: string;
      avatarUrl?: string;
      externalIds?: Record<string, string>;
    },
  ) {
    let existing = null;

    if (data.externalIds) {
      const contacts = await this.prisma.contact.findMany({ where: { tenantId } });
      outer: for (const c of contacts) {
        const ids = c.externalIds as Record<string, string>;
        for (const [key, val] of Object.entries(data.externalIds)) {
          if (ids[key] === val) {
            existing = c;
            break outer;
          }
        }
      }
    }

    if (!existing && data.phone) {
      existing = await this.prisma.contact.findFirst({
        where: { tenantId, phone: data.phone },
      });
    }

    if (existing) {
      const updates: { name?: string; avatarUrl?: string } = {};
      if (data.avatarUrl && data.avatarUrl !== existing.avatarUrl) {
        updates.avatarUrl = data.avatarUrl;
      }
      if (data.name && !existing.name) {
        updates.name = data.name;
      }
      if (Object.keys(updates).length > 0) {
        return this.prisma.contact.update({
          where: { id: existing.id },
          data: updates,
        });
      }
      return existing;
    }

    return this.prisma.contact.create({
      data: {
        tenantId,
        name: data.name,
        phone: data.phone,
        avatarUrl: data.avatarUrl,
        externalIds: data.externalIds ?? {},
      },
    });
  }
}
