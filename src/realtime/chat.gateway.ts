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
import { JwtService } from '@nestjs/jwt';
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
 *   4. On (re)connect the client emits `sync`; the server replays everything THIS DEVICE has not acked.
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
    private readonly jwt: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    const { token, deviceId } = client.handshake.auth ?? {};
    try {
      if (!token || !deviceId) throw new Error('token and deviceId required');
      client.data.userId = (await this.jwt.verifyAsync(token)).sub as string;
      client.data.deviceId = deviceId as string;
    } catch {
      client.disconnect(true);
      return;
    }
    await this.presence.addConnection(client.data.userId, client.id);
    this.logger.log(`${client.data.userId}/${deviceId} connected (${client.id})`);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    this.unsubscribers.get(client.id)?.();
    this.unsubscribers.delete(client.id);
    void this.presence.removeConnection(userId, client.id);
    this.logger.log(`${userId} disconnected (${client.id})`);
  }

  /**
   * Client calls this right after connecting. Replay first, then subscribe —
   * both happen synchronously so no message can slip through the gap.
   */
  @SubscribeMessage('sync')
  async handleSync(@ConnectedSocket() client: Socket) {
    const { userId, deviceId } = client.data;
    // Subscribe first, then replay: a message landing in between is delivered twice at worst, never lost.
    this.unsubscribers.get(client.id)?.();
    this.unsubscribers.set(client.id, this.messages.onMessage(userId, (m) => this.deliver(client, m)));
    const pending = await this.messages.getPending(userId, deviceId);
    pending.forEach((m) => this.deliver(client, m));
    return { replayed: pending.length }; // returned value = ack to the client's emit
  }

  /** Clients can also send over the socket instead of HTTP POST. */
  @SubscribeMessage('send')
  async handleSend(@ConnectedSocket() client: Socket, @MessageBody() body: { to: string; text: string }) {
    if (!body?.to || !body?.text?.trim()) return { ok: false, error: 'to and text are required' };
    try {
      const message = await this.messages.send(client.data.userId, body.to, 'chat', { text: body.text.trim() });
      return { ok: true, message, recipientOnline: await this.presence.isOnline(body.to) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async deliver(client: Socket, message: ChatMessage, attempt = 1) {
    const { userId, deviceId } = client.data;
    if (!client.connected || !(await this.messages.isPending(userId, deviceId, message.seq))) return;

    client
      .timeout(this.ACK_TIMEOUT_MS)
      .emit('message', { ...message, attempt }, (err: Error | null) => {
        if (!err) {
          void this.messages.ackOne(userId, deviceId, message.seq);
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
