import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../presence/presence.service';
import { Auth, AuthGuard, CurrentAuth } from '../auth/auth';

/**
 * SERVER-SENT EVENTS
 * One long-lived HTTP response the server streams into; one direction only, so
 * acks go back with POST /messages/ack. The browser's EventSource reconnects by itself,
 * and each reconnect replays whatever this device has not acked yet.
 */
@Controller('sse')
@UseGuards(AuthGuard)
export class SseController {
  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  @Sse()
  stream(@CurrentAuth() { userId, deviceId }: Auth): Observable<MessageEvent> {
    return new Observable((sub) => {
      const connId = `sse:${randomUUID()}`;
      const emit = (m: { seq: number }) => sub.next({ id: String(m.seq), type: 'message', data: m });
      // Subscribe first, then replay; clients dedupe by id so overlap is harmless.
      const off = this.messages.onMessage(userId, emit);
      void this.presence.addConnection(userId, connId);
      this.messages.getPending(userId, deviceId).then((pending) => pending.forEach(emit), (e) => sub.error(e));
      return () => {
        off();
        void this.presence.removeConnection(userId, connId);
      };
    });
  }
}
