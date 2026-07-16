import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { MetaService } from './meta.service';

@Controller('webhooks/meta')
export class MetaController {
  constructor(
    private readonly metaService: MetaService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken = this.configService.get<string>('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  @Post()
  async handle(
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: Record<string, unknown>,
  ) {
    const secret = this.configService.get<string>('META_APP_SECRET');
    if (secret && signature) {
      const raw = JSON.stringify(body);
      const expected =
        'sha256=' +
        crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (signature !== expected) {
        return { success: false };
      }
    }
    await this.metaService.handleWebhook(body);
    return { success: true };
  }
}
