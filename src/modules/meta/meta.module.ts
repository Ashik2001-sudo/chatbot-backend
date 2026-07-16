import { Module, forwardRef } from '@nestjs/common';
import { MetaService } from './meta.service';
import { MetaController } from './meta.controller';
import { ChannelModule } from '../channel/channel.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [forwardRef(() => ChannelModule), forwardRef(() => MessageModule)],
  controllers: [MetaController],
  providers: [MetaService],
  exports: [MetaService],
})
export class MetaModule {}
