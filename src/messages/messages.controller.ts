import { BadRequestException, Body, Controller, Get, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { PresenceService } from '../presence/presence.service';
import { PushService } from '../push/push.service';
import { Auth, AuthGuard, CurrentAuth } from '../auth/auth';

@Controller('messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
    private readonly push: PushService,
  ) {}

  /** Sending is plain HTTP regardless of how the recipient receives. The sender is the token's user. */
  @Post()
  @UseGuards(AuthGuard)
  async send(@CurrentAuth() auth: Auth, @Body() body: { to?: string; text?: string }) {
    const { to, text } = body ?? {};
    if (!to || !text?.trim()) throw new BadRequestException('to and text are required');
    const message = await this.messages.send(auth.userId, to, 'chat', { text: text.trim() });
    return { message, recipientOnline: await this.presence.isOnline(to) };
  }

  /** Acks are per device: acking here does not remove anything for the user's other devices. */
  @Post('ack')
  @UseGuards(AuthGuard)
  async ack(@CurrentAuth() auth: Auth, @Body() body: { upToSeq?: number }) {
    if (typeof body?.upToSeq !== 'number') throw new BadRequestException('numeric upToSeq is required');
    return { acked: await this.messages.ackUpTo(auth.userId, auth.deviceId, body.upToSeq) };
  }

  /** Read receipt for a chat message; delivered to the original sender like any other message. */
  @Post('seen')
  @UseGuards(AuthGuard)
  async seen(@CurrentAuth() auth: Auth, @Body() body: { messageId?: string; from?: string }) {
    if (!body?.messageId || !body.from) throw new BadRequestException('messageId and from are required');
    const message = await this.messages.markSeen(auth.userId, body.from, body.messageId);
    if (!message) throw new NotFoundException('no such message');
    return { message };
  }

  /** The app registers its FCM token so the server can wake it when it is offline. */
  @Post('push-token')
  @UseGuards(AuthGuard)
  async pushToken(@CurrentAuth() auth: Auth, @Body() body: { token?: string }) {
    if (!body?.token) throw new BadRequestException('token is required');
    await this.push.register(auth.userId, auth.deviceId, body.token);
    return { ok: true };
  }

  /** Peek at server state while experimenting. */
  @Get('debug')
  async debug() {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    return { inboxes: await this.messages.debugSnapshot(), presence: await this.presence.snapshot() };
  }
}
