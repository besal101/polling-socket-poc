export interface ChatMessage {
  /** Globally unique. Clients use it to drop duplicates (at-least-once delivery means dupes WILL happen). */
  id: string;
  /** Per-recipient, monotonically increasing. Used for ordering and as a polling cursor. */
  seq: number;
  /** 'chat' carries { text }; 'seen' is a read receipt carrying { messageId }. */
  kind: 'chat' | 'seen';
  from: string;
  to: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
