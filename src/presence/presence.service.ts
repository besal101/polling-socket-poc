import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../infra/infra.module';

/**
 * "Is the user online?" has to be answered across instances, so it lives in Redis:
 * one sorted set per user, member = connection id, score = expiry time.
 *  - WebSocket/SSE: we hold the connection; a heartbeat keeps the entry alive, and a
 *                   crashed instance's entries simply expire.
 *  - Polling:       we only know when they last asked, so the 'poll' entry lives a grace window.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly CONN_TTL_MS = 60_000;
  private readonly POLL_GRACE_MS = 35_000;
  private readonly local = new Map<string, string>(); // connection id -> userId
  private timer?: NodeJS.Timeout;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleInit() {
    this.timer = setInterval(() => this.local.forEach((u, id) => this.touch(u, id)), 20_000);
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private touch(userId: string, id: string, ttl = this.CONN_TTL_MS) {
    return this.redis.zadd(`presence:${userId}`, Date.now() + ttl, id).catch(() => undefined);
  }

  addConnection(userId: string, id: string) {
    this.local.set(id, userId);
    return this.touch(userId, id);
  }

  removeConnection(userId: string, id: string) {
    this.local.delete(id);
    return this.redis.zrem(`presence:${userId}`, id);
  }

  touchPoll(userId: string) {
    return this.touch(userId, 'poll', this.POLL_GRACE_MS);
  }

  async isOnline(userId: string): Promise<boolean> {
    const key = `presence:${userId}`;
    await this.redis.zremrangebyscore(key, '-inf', Date.now());
    return (await this.redis.zcard(key)) > 0;
  }

  async snapshot() {
    const out: Record<string, { online: boolean; connections: number }> = {};
    for (const key of await this.redis.keys('presence:*')) {
      const user = key.slice('presence:'.length);
      const ids = await this.redis.zrangebyscore(key, Date.now(), '+inf');
      out[user] = { online: ids.length > 0, connections: ids.filter((i) => i !== 'poll').length };
    }
    return out;
  }
}
