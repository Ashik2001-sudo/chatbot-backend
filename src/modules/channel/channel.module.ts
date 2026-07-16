import { Module, forwardRef } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { ChannelController } from './channel.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ConversationModule } from '../conversation/conversation.module';

@Module({
  imports: [forwardRef(() => WhatsAppModule), ConversationModule],
  controllers: [ChannelController],
  providers: [ChannelService],
  exports: [ChannelService],
})
export class ChannelModule {}
