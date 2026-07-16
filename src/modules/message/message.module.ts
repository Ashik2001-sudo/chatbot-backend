import { Module, forwardRef } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';
import { ConversationModule } from '../conversation/conversation.module';
import { ContactModule } from '../contact/contact.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { MetaModule } from '../meta/meta.module';

@Module({
  imports: [
    ConversationModule,
    ContactModule,
    RealtimeModule,
    forwardRef(() => WhatsAppModule),
    forwardRef(() => MetaModule),
  ],
  controllers: [MessageController],
  providers: [MessageService],
  exports: [MessageService],
})
export class MessageModule {}
