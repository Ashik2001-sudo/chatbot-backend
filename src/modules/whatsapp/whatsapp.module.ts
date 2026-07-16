import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { BaileysProvider } from './providers/baileys.provider';
import { WhatsAppCloudProvider } from './providers/cloud-api.provider';
import { ChannelModule } from '../channel/channel.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [
    forwardRef(() => ChannelModule),
    RealtimeModule,
    forwardRef(() => MessageModule),
  ],
  providers: [WhatsAppService, BaileysProvider, WhatsAppCloudProvider],
  exports: [WhatsAppService, BaileysProvider],
})
export class WhatsAppModule {}
