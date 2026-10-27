import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../presence/presence.service';
import { Auth, AuthGuard, CurrentAuth } from '../auth/auth';

/**
 * SHORT POLLING
 * Client asks every N seconds: "anything new since seq X?"
 * Server answers IMMEDIATELY, usually with an empty list.
 *
 * + dead simple, works through every proxy/firewall, stateless server
 * - latency up to N seconds, lots of wasted requests
 */
@Controller('short-poll')
@UseGuards(AuthGuard)
export class ShortPollController {
  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  @Get()
  async poll(@CurrentAuth() { userId }: Auth, @Query('since') since = '0') {
    await this.presence.touchPoll(userId);
    return { messages: await this.messages.getSince(userId, Number(since) || 0) };
  }
}
