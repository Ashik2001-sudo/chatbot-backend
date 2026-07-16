import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        role: string;
        tenantId: string;
      }>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Never authorize from a potentially stale role embedded in the JWT.
      // Re-check the active user, tenant membership and current role in DB so
      // demotions/deactivations take effect immediately.
      const user = await this.prisma.user.findFirst({
        where: {
          id: payload.sub,
          tenantId: payload.tenantId,
          isActive: true,
        },
        select: {
          id: true,
          email: true,
          role: true,
          tenantId: true,
        },
      });
      if (!user) throw new UnauthorizedException('User is no longer active');

      (request as Request & { user: unknown })['user'] = {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: Request): string | undefined {
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return undefined;
  }
}
