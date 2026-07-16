import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async signup(dto: SignupDto) {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const slug = dto.tenantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug } });
    const finalSlug = slugTaken ? `${slug}-${Date.now()}` : slug;

    const hashed = await bcrypt.hash(dto.password, 10);

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.tenantName,
        slug: finalSlug,
        users: {
          create: {
            email: dto.email,
            password: hashed,
            name: dto.name,
            role: 'owner',
          },
        },
      },
      include: { users: true },
    });

    const user = tenant.users[0];
    return this.buildAuthResponse(user, tenant);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, isActive: true },
      include: { tenant: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildAuthResponse(user, user.tenant);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {
      user: this.sanitizeUser(user),
      tenant: user.tenant,
    };
  }

  private buildAuthResponse(
    user: { id: string; email: string; name: string; role: string; tenantId: string },
    tenant: { id: string; name: string; slug: string },
  ) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    return {
      success: true,
      data: {
        accessToken: this.jwtService.sign(payload),
        user: this.sanitizeUser(user),
        tenant,
      },
    };
  }

  private sanitizeUser(user: {
    id: string;
    email: string;
    name: string;
    role: string;
    tenantId: string;
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
