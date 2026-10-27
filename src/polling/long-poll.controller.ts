import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../presence/presence.service';
import { Auth, AuthGuard, CurrentAuth } from '../auth/auth';

/**
 * LONG POLLING
 * Client asks "anything new since seq X?" and the server HOLDS the request
 * open until a message arrives or a timeout (~25s) passes. Then the client
 * immediately asks again.
 *
 * + near real-time, still plain HTTP, far fewer empty responses
 * - one held connection per client, timeouts must stay below proxy/LB idle limits
 */
@Controller('long-poll')
@UseGuards(AuthGuard)
export class LongPollController {
  private readonly MAX_TIMEOUT_MS = 30_000;

  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  @Get()
  async poll(
    @CurrentAuth() { userId }: Auth,
    @Query('since') since = '0',
    @Query('timeout') timeout = '25000',
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.presence.touchPoll(userId);

    // If the client disconnects (tab closed, user went offline), stop waiting.
    // Note: listen on res 'close', not req 'close' — the latter fires once the body is read.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const timeoutMs = Math.min(Number(timeout) || 25_000, this.MAX_TIMEOUT_MS);
    const started = Date.now();
    const messages = await this.messages.waitForMessages(
      userId,
      Number(since) || 0,
      timeoutMs,
      abort.signal,
    );
    await this.presence.touchPoll(userId);
    return { messages, heldForMs: Date.now() - started };
  }
}
