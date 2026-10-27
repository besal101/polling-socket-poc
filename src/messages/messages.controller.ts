import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { PresenceService } from '../presence/presence.service';

@Controller('messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  /** Sending is plain HTTP regardless of how the recipient receives. */
  @Post()
  send(@Body() body: { from?: string; to?: string; text?: string }) {
    const { from, to, text } = body ?? {};
    if (!from || !to || !text?.trim()) {
      throw new BadRequestException('from, to and text are required');
    }
    const message = this.messages.send(from, to, text.trim());
    return { message, recipientOnline: this.presence.isOnline(to) };
  }

  /** Polling clients confirm receipt so the server can drop the message. */
  @Post('ack')
  ack(@Body() body: { userId?: string; upToSeq?: number }) {
    if (!body?.userId || typeof body.upToSeq !== 'number') {
      throw new BadRequestException('userId and numeric upToSeq are required');
    }
    return { removed: this.messages.ackUpTo(body.userId, body.upToSeq) };
  }

  /** Peek at server state while experimenting. */
  @Get('debug')
  debug() {
    return { inboxes: this.messages.debugSnapshot(), presence: this.presence.snapshot() };
  }
}
