export interface ChatMessage {
  /** Globally unique. Clients use it to drop duplicates (at-least-once delivery means dupes WILL happen). */
  id: string;
  /** Per-recipient, monotonically increasing. Used for ordering and as a polling cursor. */
  seq: number;
  from: string;
  to: string;
  text: string;
  createdAt: string;
}
