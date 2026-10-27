import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ChatMessage } from './message.types';

/**
 * A per-user "inbox" (a.k.a. mailbox / store-and-forward pattern).
 *
 * The key idea behind offline delivery: a message is never "sent to a socket",
 * it is first STORED for the recipient. Delivery is a separate step that can
 * happen now (user online) or later (user comes back). A message only leaves
 * the inbox when the client ACKNOWLEDGES it.
 *
 * In production, swap this Map for Redis / Postgres so messages survive restarts
 * and work across multiple server instances.
 */
interface Inbox {
  nextSeq: number;
  /** Highest seq the client has confirmed via a cumulative ack (polling style). */
  ackedUpTo: number;
  /** Messages stored but not yet acknowledged. */
  pending: ChatMessage[];
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  private readonly inboxes = new Map<string, Inbox>();
  /** In-process pub/sub. In a multi-instance deployment this becomes Redis pub/sub. */
  private readonly events = new EventEmitter().setMaxListeners(0);

  private inbox(userId: string): Inbox {
    let inbox = this.inboxes.get(userId);
    if (!inbox) {
      inbox = { nextSeq: 1, ackedUpTo: 0, pending: [] };
      this.inboxes.set(userId, inbox);
    }
    return inbox;
  }

  /** 1) persist, 2) notify whoever is listening. Persist ALWAYS comes first. */
  send(from: string, to: string, text: string): ChatMessage {
    const inbox = this.inbox(to);
    const message: ChatMessage = {
      id: randomUUID(),
      seq: inbox.nextSeq++,
      from,
      to,
      text,
      createdAt: new Date().toISOString(),
    };
    inbox.pending.push(message);
    this.logger.log(`stored #${message.seq} ${from} -> ${to} (pending: ${inbox.pending.length})`);
    this.events.emit(`inbox:${to}`, message);
    return message;
  }

  /** Cursor-based read: "give me everything after seq N". Used by polling clients. */
  getSince(userId: string, sinceSeq: number): ChatMessage[] {
    return this.inbox(userId).pending.filter((m) => m.seq > sinceSeq);
  }

  /** Everything not yet acknowledged. Used by WebSocket clients on (re)connect. */
  getPending(userId: string): ChatMessage[] {
    return [...this.inbox(userId).pending];
  }

  isPending(userId: string, seq: number): boolean {
    return this.inbox(userId).pending.some((m) => m.seq === seq);
  }

  /** Cumulative ack (like TCP): "I have everything up to and including N". */
  ackUpTo(userId: string, upToSeq: number): number {
    const inbox = this.inbox(userId);
    const before = inbox.pending.length;
    inbox.pending = inbox.pending.filter((m) => m.seq > upToSeq);
    inbox.ackedUpTo = Math.max(inbox.ackedUpTo, upToSeq);
    return before - inbox.pending.length;
  }

  /** Selective ack: "I have message N" (order-independent). Used per WebSocket frame. */
  ackOne(userId: string, seq: number): boolean {
    const inbox = this.inbox(userId);
    const before = inbox.pending.length;
    inbox.pending = inbox.pending.filter((m) => m.seq !== seq);
    return inbox.pending.length < before;
  }

  /** Subscribe to new messages for a user. Returns an unsubscribe function. */
  onMessage(userId: string, listener: (m: ChatMessage) => void): () => void {
    const event = `inbox:${userId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  /**
   * The heart of long polling: resolve immediately if there is data,
   * otherwise park the request until a message arrives, the timeout hits,
   * or the client goes away.
   */
  waitForMessages(
    userId: string,
    sinceSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const existing = this.getSince(userId, sinceSeq);
    if (existing.length > 0) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let done = false;
      const finish = (messages: ChatMessage[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(messages);
      };
      const unsubscribe = this.onMessage(userId, () => finish(this.getSince(userId, sinceSeq)));
      const timer = setTimeout(() => finish([]), timeoutMs);
      const onAbort = () => finish([]);
      signal?.addEventListener('abort', onAbort);
    });
  }

  debugSnapshot() {
    return Object.fromEntries(
      [...this.inboxes].map(([user, i]) => [
        user,
        { nextSeq: i.nextSeq, ackedUpTo: i.ackedUpTo, pending: i.pending.map((m) => m.seq) },
      ]),
    );
  }
}
