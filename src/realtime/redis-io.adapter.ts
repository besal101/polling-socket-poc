import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/** Lets socket.io rooms/broadcasts span instances. (Message delivery itself goes through MessagesService pub/sub.) */
export class RedisIoAdapter extends IoAdapter {
  private readonly adapter = (() => {
    const pub = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    return createAdapter(pub, pub.duplicate());
  })();

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapter);
    return server;
  }
}
