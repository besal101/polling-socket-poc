import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG } from '../infra/infra.module';

/**
 * The push carries no content: it only wakes the app, which then syncs over the normal channel.
 * FCM covers Android and iOS (APNs is configured inside the Firebase project).
 * Without GOOGLE_APPLICATION_CREDENTIALS this only logs.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private fcm?: Promise<import('firebase-admin/messaging').Messaging>;

  constructor(@Inject(PG) private readonly pg: Pool) {}

  register(userId: string, deviceId: string, token: string) {
    return this.pg.query(
      `INSERT INTO push_tokens VALUES ($1,$2,$3) ON CONFLICT (user_id, device_id) DO UPDATE SET token = $3`,
      [userId, deviceId, token],
    );
  }

  async notify(userId: string) {
    try {
      const { rows } = await this.pg.query('SELECT device_id, token FROM push_tokens WHERE user_id = $1', [userId]);
      if (!rows.length) return;
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        this.logger.log(`would push to ${rows.length} device(s) of ${userId} (FCM not configured)`);
        return;
      }
      this.fcm ??= (async () => {
        const { initializeApp, applicationDefault } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        return getMessaging(initializeApp({ credential: applicationDefault() }));
      })();
      const res = await (await this.fcm).sendEach(
        rows.map((r) => ({
          token: r.token,
          notification: { title: 'You have a message' },
          data: { type: 'sync' },
          apns: { payload: { aps: { 'content-available': 1 } } },
        })),
      );
      const dead = rows.filter((_, i) => res.responses[i].error?.code === 'messaging/registration-token-not-registered');
      if (dead.length) await this.pg.query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead.map((r) => r.token)]);
    } catch (e) {
      this.logger.error(`push to ${userId} failed: ${(e as Error).message}`);
    }
  }
}
