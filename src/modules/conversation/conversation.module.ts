import { Module, forwardRef } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';
import { ContactModule } from '../contact/contact.module';

@Module({
  imports: [ContactModule],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
