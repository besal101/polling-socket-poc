import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MessagesService } from './messages/messages.service';
import { MessagesController } from './messages/messages.controller';
import { PresenceService } from './presence/presence.service';
import { PushService } from './push/push.service';
import { InfraModule } from './infra/infra.module';
import { AuthController, AuthGuard, JWT_SECRET } from './auth/auth';
import { ShortPollController } from './polling/short-poll.controller';
import { LongPollController } from './polling/long-poll.controller';
import { SseController } from './realtime/sse.controller';
import { ChatGateway } from './realtime/chat.gateway';

@Module({
  imports: [InfraModule, JwtModule.register({ global: true, secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [AuthController, MessagesController, ShortPollController, LongPollController, SseController],
  providers: [MessagesService, PresenceService, PushService, ChatGateway, AuthGuard],
})
export class AppModule {}
