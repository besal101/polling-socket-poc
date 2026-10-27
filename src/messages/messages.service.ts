import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { ChatMessage } from './message.types';
import { PG, REDIS } from '../infra/infra.module';
import { PresenceService } from '../presence/presence.service';
import { PushService } from '../push/push.service';

/**
 * A per-user "inbox" (a.k.a. mailbox / store-and-forward pattern).
 *
 * A message is never "sent to a socket", it is first STORED for the recipient (Postgres).
 * Delivery is a separate step that can happen now or later. Each DEVICE acknowledges
 * independently (message_acks), so a phone and a laptop both get every message.
 * Messages are removed only by expiry or by the inbox cap.
 */
const TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS ?? 7);
const INBOX_MAX = Number(process.env.INBOX_MAX ?? 1000);
const SENDS_PER_MIN = Number(process.env.SENDS_PER_MIN ?? 30);

const ROW = `id, seq, kind, sender AS "from", recipient AS "to", payload, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
const LIVE = `created_at > now() - make_interval(days => ${TTL_DAYS})`;

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagesService.name);
  /** Local fan-out to this instance's sockets; fed by Redis pub/sub so it spans instances. */
  private readonly events = new EventEmitter().setMaxListeners(0);
  private sub!: Redis;
  private expiry?: NodeJS.Timeout;

  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly presence: PresenceService,
    private readonly push: PushService,
  ) {}

  async onModuleInit() {
    this.sub = this.redis.duplicate();
    this.sub.on('pmessage', (_p, channel, data) => this.events.emit(channel, JSON.parse(data)));
    await this.sub.psubscribe('inbox:*');
    this.expiry = setInterval(
      () => this.pg.query(`DELETE FROM messages WHERE NOT (${LIVE})`).catch((e) => this.logger.error(e.message)),
      3_600_000,
    );
  }
  onModuleDestroy() {
    clearInterval(this.expiry);
    this.sub.disconnect();
  }

  /** Fixed window per sender, shared by all instances. */
  private async limit(userId: string) {
    const key = `rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > SENDS_PER_MIN) throw new HttpException('rate limit exceeded', 429);
  }

  /** 1) persist (seq assigned atomically, inbox capped), 2) publish, 3) push if truly offline. */
  async send(from: string, to: string, kind: ChatMessage['kind'], payload: Record<string, unknown>): Promise<ChatMessage> {
    await this.limit(from);
    const { rows } = await this.pg.query<ChatMessage>(
      `WITH s AS (
         INSERT INTO inbox_seq (recipient, last) VALUES ($1, 1)
         ON CONFLICT (recipient) DO UPDATE SET last = inbox_seq.last + 1 RETURNING last),
       ins AS (
         INSERT INTO messages (id, recipient, seq, sender, kind, payload)
         SELECT $2, $1, last, $3, $4, $5 FROM s RETURNING *),
       cap AS (DELETE FROM messages WHERE recipient = $1 AND seq <= (SELECT last FROM s) - $6)
       SELECT ${ROW} FROM ins`,
      [to, randomUUID(), from, kind, payload, INBOX_MAX],
    );
    const message = rows[0];
    this.logger.log(`stored #${message.seq} ${from} -> ${to} (${kind})`);
    await this.redis.publish(`inbox:${to}`, JSON.stringify(message));
    if (!(await this.presence.isOnline(to))) void this.push.notify(to);
    return message;
  }

  /** Cursor-based read: "give me everything after seq N". Used by polling clients. */
  async getSince(userId: string, sinceSeq: number): Promise<ChatMessage[]> {
    const { rows } = await this.pg.query<ChatMessage>(
      `SELECT ${ROW} FROM messages WHERE recipient = $1 AND seq > $2 AND ${LIVE} ORDER BY seq`,
      [userId, sinceSeq],
    );
    return rows;
  }

  /** Everything this device has not acknowledged. Used by WebSocket/SSE clients on (re)connect. */
  async getPending(userId: string, deviceId: string): Promise<ChatMessage[]> {
    const { rows } = await this.pg.query<ChatMessage>(
      `SELECT ${ROW} FROM messages m WHERE recipient = $1 AND ${LIVE}
         AND NOT EXISTS (SELECT 1 FROM message_acks a WHERE a.message_id = m.id AND a.device_id = $2)
       ORDER BY seq`,
      [userId, deviceId],
    );
    return rows;
  }

  async isPending(userId: string, deviceId: string, seq: number): Promise<boolean> {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM messages m WHERE recipient = $1 AND seq = $3
         AND NOT EXISTS (SELECT 1 FROM message_acks a WHERE a.message_id = m.id AND a.device_id = $2)`,
      [userId, deviceId, seq],
    );
    return !!rowCount;
  }

  /** Cumulative ack (like TCP): "this device has everything up to and including N". */
  async ackUpTo(userId: string, deviceId: string, upToSeq: number): Promise<number> {
    const { rowCount } = await this.pg.query(
      `INSERT INTO message_acks SELECT id, $2::text FROM messages WHERE recipient = $1 AND seq <= $3 ON CONFLICT DO NOTHING`,
      [userId, deviceId, upToSeq],
    );
    return rowCount ?? 0;
  }

  /** Selective ack: "this device has message N" (order-independent). Used per WebSocket frame. */
  async ackOne(userId: string, deviceId: string, seq: number): Promise<boolean> {
    const { rowCount } = await this.pg.query(
      `INSERT INTO message_acks SELECT id, $2::text FROM messages WHERE recipient = $1 AND seq = $3 ON CONFLICT DO NOTHING`,
      [userId, deviceId, seq],
    );
    return !!rowCount;
  }

  /** Read receipt: tell the original sender their message was seen. A 'seen' is itself a stored message. */
  async markSeen(userId: string, senderId: string, messageId: string): Promise<ChatMessage | null> {
    const { rowCount } = await this.pg.query(
      `SELECT 1 FROM messages WHERE id = $1 AND recipient = $2 AND sender = $3 AND kind = 'chat'`,
      [messageId, userId, senderId],
    );
    return rowCount ? this.send(userId, senderId, 'seen', { messageId }) : null;
  }

  /** Subscribe to new messages for a user (from any instance). Returns an unsubscribe function. */
  onMessage(userId: string, listener: (m: ChatMessage) => void): () => void {
    const event = `inbox:${userId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  /**
   * The heart of long polling: resolve immediately if there is data,
   * otherwise park the request until a message arrives, the timeout hits,
   * or the client goes away. Subscribe BEFORE querying so nothing slips between.
   */
  waitForMessages(userId: string, sinceSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<ChatMessage[]> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (messages: ChatMessage[] = []) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(messages);
      };
      const check = () =>
        this.getSince(userId, sinceSeq).then((m) => m.length && finish(m), (e) => this.logger.error(e.message));
      const unsubscribe = this.onMessage(userId, check);
      const timer = setTimeout(() => finish(), timeoutMs);
      const onAbort = () => finish();
      signal?.addEventListener('abort', onAbort);
      void check();
    });
  }

  async debugSnapshot() {
    const { rows } = await this.pg.query(
      `SELECT recipient, max(seq) AS "lastSeq", count(*)::int AS stored FROM messages GROUP BY recipient`,
    );
    return Object.fromEntries(rows.map((r) => [r.recipient, { lastSeq: r.lastSeq, stored: r.stored }]));
  }
}
