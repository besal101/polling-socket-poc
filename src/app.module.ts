import { Module } from '@nestjs/common';
import { MessagesService } from './messages/messages.service';
import { MessagesController } from './messages/messages.controller';
import { PresenceService } from './presence/presence.service';
import { ShortPollController } from './polling/short-poll.controller';
import { LongPollController } from './polling/long-poll.controller';
import { ChatGateway } from './realtime/chat.gateway';

@Module({
  controllers: [MessagesController, ShortPollController, LongPollController],
  providers: [MessagesService, PresenceService, ChatGateway],
})
export class AppModule {}
