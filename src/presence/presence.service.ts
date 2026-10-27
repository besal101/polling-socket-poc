import { Injectable } from '@nestjs/common';

/**
 * "Is the user online?" means different things per transport:
 *  - WebSocket: we hold an open connection, so we know exactly.
 *  - Polling:  we only know when they last asked. We guess "online" if they
 *              polled within a grace window (heartbeat-style).
 */
@Injectable()
export class PresenceService {
  private readonly sockets = new Map<string, Set<string>>();
  private readonly lastPoll = new Map<string, number>();
  private readonly POLL_GRACE_MS = 35_000;

  addSocket(userId: string, socketId: string) {
    if (!this.sockets.has(userId)) this.sockets.set(userId, new Set());
    this.sockets.get(userId)!.add(socketId);
  }

  removeSocket(userId: string, socketId: string) {
    const set = this.sockets.get(userId);
    set?.delete(socketId);
    if (set?.size === 0) this.sockets.delete(userId);
  }

  touchPoll(userId: string) {
    this.lastPoll.set(userId, Date.now());
  }

  isOnline(userId: string): boolean {
    if (this.sockets.has(userId)) return true;
    const last = this.lastPoll.get(userId);
    return last !== undefined && Date.now() - last < this.POLL_GRACE_MS;
  }

  snapshot() {
    const users = new Set([...this.sockets.keys(), ...this.lastPoll.keys()]);
    return Object.fromEntries(
      [...users].map((u) => [
        u,
        {
          online: this.isOnline(u),
          sockets: this.sockets.get(u)?.size ?? 0,
          lastPollMsAgo: this.lastPoll.has(u) ? Date.now() - this.lastPoll.get(u)! : null,
        },
      ]),
    );
  }
}
