import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { ChannelModule } from '../channel/channel.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [ChannelModule, MessageModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
