import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  listByTenant(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async invite(tenantId: string, data: { email: string; name: string; role: string; password: string }) {
    const bcrypt = await import('bcrypt');
    const hashed = await bcrypt.hash(data.password, 10);
    return this.prisma.user.create({
      data: {
        tenantId,
        email: data.email,
        name: data.name,
        role: data.role as 'admin' | 'agent',
        password: hashed,
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  }
}
