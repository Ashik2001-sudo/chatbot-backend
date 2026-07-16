import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {}

  @Get('whatsapp')
  verifyWhatsApp(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken = this.configService.get<string>(
      'WHATSAPP_CLOUD_VERIFY_TOKEN',
    );
    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  @Post('whatsapp')
  async handleWhatsApp(@Body() body: Record<string, unknown>) {
    await this.webhookService.handleWhatsAppCloudWebhook(body);
    return { success: true };
  }
}
