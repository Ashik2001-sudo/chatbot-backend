import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { ChannelModule } from './modules/channel/channel.module';
import { ContactModule } from './modules/contact/contact.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { MessageModule } from './modules/message/message.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { MetaModule } from './modules/meta/meta.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { UploadModule } from './modules/upload/upload.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UserModule,
    ChannelModule,
    ContactModule,
    ConversationModule,
    MessageModule,
    RealtimeModule,
    WhatsAppModule,
    MetaModule,
    WebhookModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
