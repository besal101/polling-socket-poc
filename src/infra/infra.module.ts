import { Global, Module } from '@nestjs/common';
import { Pool, types } from 'pg';
import Redis from 'ioredis';

export const PG = Symbol('PG');
export const REDIS = Symbol('REDIS');

types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint seq -> number

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_seq (recipient text PRIMARY KEY, last bigint NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id         uuid PRIMARY KEY,
  recipient  text NOT NULL,
  seq        bigint NOT NULL,
  sender     text NOT NULL,
  kind       text NOT NULL DEFAULT 'chat',  -- 'chat' | 'seen'
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient, seq)                   -- also serves as the (recipient, seq) index
);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);
-- One row = "this device has this message". Replaces messages.acked_at: acks are per device.
CREATE TABLE IF NOT EXISTS message_acks (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id  text NOT NULL,
  PRIMARY KEY (message_id, device_id)
);
CREATE TABLE IF NOT EXISTS push_tokens (
  user_id text NOT NULL, device_id text NOT NULL, token text NOT NULL,
  PRIMARY KEY (user_id, device_id)
);`;

@Global()
@Module({
  providers: [
    {
      provide: PG,
      useFactory: async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres' });
        // The lock keeps two instances booting together from racing on CREATE TABLE.
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT pg_advisory_xact_lock(42)');
          await c.query(SCHEMA);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
        return pool;
      },
    },
    { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379') },
  ],
  exports: [PG, REDIS],
})
export class InfraModule {}
