import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { MessagesService } from '../messages/messages.service';
import { PresenceService } from '../presence/presence.service';
import { ChatMessage } from '../messages/message.types';

/**
 * WEBSOCKETS (via socket.io)
 * One persistent, full-duplex connection. The server pushes the moment
 * something happens, and the client can send over the same pipe.
 *
 * Delivery guarantee implemented here: AT-LEAST-ONCE
 *   1. Every push uses an ack callback with a timeout.
 *   2. No ack -> retry a few times while connected.
 *   3. Still no ack / disconnected -> message stays pending in the inbox.
 *   4. On (re)connect the client emits `sync`; the server replays all pending.
 *   5. The client drops duplicates by message id.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly ACK_TIMEOUT_MS = 5_000;
  private readonly MAX_ATTEMPTS = 3;

  constructor(
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
  ) {}

  handleConnection(client: Socket) {
    // Real apps: verify a JWT here instead of trusting a userId.
    const userId = client.handshake.auth?.userId as string | undefined;
    if (!userId) {
      client.disconnect(true);
      return;
    }
    client.data.userId = userId;
    this.presence.addSocket(userId, client.id);
    this.logger.log(`${userId} connected (${client.id})`);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    this.unsubscribers.get(client.id)?.();
    this.unsubscribers.delete(client.id);
    this.presence.removeSocket(userId, client.id);
    this.logger.log(`${userId} disconnected (${client.id})`);
  }

  /**
   * Client calls this right after connecting. Replay first, then subscribe —
   * both happen synchronously so no message can slip through the gap.
   */
  @SubscribeMessage('sync')
  handleSync(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string;
    const pending = this.messages.getPending(userId);
    pending.forEach((m) => this.deliver(client, m));

    this.unsubscribers.get(client.id)?.();
    this.unsubscribers.set(
      client.id,
      this.messages.onMessage(userId, (m) => this.deliver(client, m)),
    );
    return { replayed: pending.length }; // returned value = ack to the client's emit
  }

  /** Clients can also send over the socket instead of HTTP POST. */
  @SubscribeMessage('send')
  handleSend(@ConnectedSocket() client: Socket, @MessageBody() body: { to: string; text: string }) {
    if (!body?.to || !body?.text?.trim()) return { ok: false, error: 'to and text are required' };
    const message = this.messages.send(client.data.userId, body.to, body.text.trim());
    return { ok: true, message, recipientOnline: this.presence.isOnline(body.to) };
  }

  private deliver(client: Socket, message: ChatMessage, attempt = 1) {
    const userId = client.data.userId as string;
    if (!client.connected || !this.messages.isPending(userId, message.seq)) return;

    client
      .timeout(this.ACK_TIMEOUT_MS)
      .emit('message', { ...message, attempt }, (err: Error | null) => {
        if (!err) {
          this.messages.ackOne(userId, message.seq);
          return;
        }
        if (attempt < this.MAX_ATTEMPTS) {
          this.logger.warn(`no ack for #${message.seq} (attempt ${attempt}), retrying`);
          setTimeout(() => this.deliver(client, message, attempt + 1), 1_000 * attempt);
        } else {
          this.logger.warn(`giving up on #${message.seq} for now — stays pending until next sync`);
        }
      });
  }
}
