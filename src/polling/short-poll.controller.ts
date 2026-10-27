import { Controller, Get, Param, Query } from '@nestjs/common';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../presence/presence.service';

/**
 * SHORT POLLING
 * Client asks every N seconds: "anything new since seq X?"
 * Server answers IMMEDIATELY, usually with an empty list.
 *
 * + dead simple, works through every proxy/firewall, stateless server
 * - latency up to N seconds, lots of wasted requests
 */
@Controller('short-poll')
export class ShortPollController {
  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  @Get(':userId')
  poll(@Param('userId') userId: string, @Query('since') since = '0') {
    this.presence.touchPoll(userId);
    return { messages: this.messages.getSince(userId, Number(since) || 0) };
  }
}
