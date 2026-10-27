# NestJS Realtime Lab

A small NestJS project for learning how servers get data to clients: short polling, long polling, and WebSockets, plus how to deliver messages reliably to users who are offline.

## Run it

```bash
npm install
npm run start:dev
```

Open two tabs:

- http://localhost:3000/?user=alice&peer=bob
- http://localhost:3000/?user=bob&peer=alice

Inspect server state at any time: `GET http://localhost:3000/messages/debug`

## Project layout

```
src/
  messages/
    messages.service.ts     The inbox: store, cursor reads, acks, pub/sub, long-poll waiting
    messages.controller.ts  POST /messages, POST /messages/ack, GET /messages/debug
  presence/
    presence.service.ts     Who is online (socket count or recent poll)
  polling/
    short-poll.controller.ts  GET /short-poll/:userId?since=N   answers immediately
    long-poll.controller.ts   GET /long-poll/:userId?since=N    holds up to 25 s
  realtime/
    chat.gateway.ts         socket.io gateway: sync, push with ack + retry, send
public/index.html           Demo client with a live "on the wire" log
```

All three transports read from the same `MessagesService`. That is the main lesson: **the transport is just how you find out; the inbox is the source of truth.**

## The three transports

### Short polling

The client asks every N seconds, "anything after seq X?", and the server answers right away, usually with nothing.

Latency is up to N seconds and most requests are wasted, but the server is stateless, it works through any proxy, and it is trivial to cache and scale. Good for dashboards that refresh every 30–60 s, checking the status of a background job (export, video encoding, payment), or as an emergency fallback.

In the demo: set the interval to 3000, watch the "Empty responses" counter climb.

### Long polling

The client asks the same question, but the server holds the request open until a message arrives or a timeout passes (25 s here), then the client immediately asks again.

Latency is near real-time and empty responses drop to about one every 25 s. The cost is one open connection per client and having to keep the timeout below your load balancer's idle timeout (AWS ALB defaults to 60 s, many proxies are 30 s). Good for notifications in environments where WebSockets are blocked, simple chat or notification feeds, and it is what socket.io itself falls back to.

Look at `waitForMessages()` in the service: check the store, otherwise subscribe and wait, and always clean up the listener on resolve, timeout, or client disconnect. Forgetting that cleanup is the classic long-polling memory leak.

### WebSockets

One persistent, two-way connection. The server pushes the moment something happens, and the client sends over the same pipe.

This gives the lowest latency and the least overhead per message, but connections are stateful, so scaling across several servers needs a shared adapter (Redis), and you must handle reconnects yourself. Good for chat, multiplayer games, collaborative editing, live location tracking, trading tickers, and anything with high-frequency updates in both directions.

### Quick comparison

| | Short polling | Long polling | WebSocket |
|---|---|---|---|
| Latency | up to interval | ~instant | instant |
| Wasted requests | many | few | none |
| Server state | none | held request | open socket |
| Client → server | separate HTTP | separate HTTP | same connection |
| Infra friendliness | best | good | needs sticky sessions/adapter |

Server-Sent Events (SSE) sit between long polling and WebSockets: one long-lived HTTP response that the server streams into, one direction only. Adding an SSE endpoint is a good exercise (see below).

## Delivering to offline users

The pattern used here is **store-and-forward with acknowledgements**, giving at-least-once delivery.

1. **Persist before you notify.** `send()` writes the message into the recipient's inbox first, then emits an event. If nobody is listening, nothing is lost.
2. **Every message has a per-recipient sequence number.** It gives ordering and a cursor ("give me everything after 41").
3. **Messages leave the inbox only when the client acks.** Polling clients send a cumulative ack (`upToSeq`, like TCP). WebSocket pushes use a per-message socket.io ack with a 5 s timeout.
4. **No ack means retry.** While connected the gateway retries 3 times with backoff. If that fails or the client disconnects, the message just stays pending.
5. **On reconnect, sync.** The client emits `sync`; the server replays everything still pending, then subscribes for live messages. Replay and subscribe happen in the same synchronous tick, so nothing slips through the gap.
6. **Clients deduplicate by message id.** At-least-once means duplicates *will* happen (an ack lost on the network looks the same as a message lost). Dropping repeats on the client turns that into effectively-once for the user.

Two cursor styles are shown on purpose. Polling uses a client-held cursor (`since`), where the client says what it has. The WebSocket path has the server send everything un-acked, where the server decides what is missing. The second is more forgiving when acks arrive out of order.

### Experiments to try in the demo

1. Take bob offline. Send him three messages from alice. Bring bob back in any mode and watch them arrive in order.
2. Bob in WebSocket mode, tick "Don’t acknowledge messages", then send from alice. In the server log you will see the retries, and bob's "Duplicates dropped" counter rises. Untick it and reconnect: the messages are finally acked.
3. Do the same with long polling, then click "Clear this device’s local state" and go online again. The un-acked messages are redelivered from seq 0, just like a fresh install on a new phone.
4. Restart the server. Everything is gone, because the store is in memory. That is the first thing to fix for production.

## Exercises (roughly in order of difficulty)

1. **Persist the inbox** in Redis or Postgres (table `messages(id, recipient, seq, payload, created_at, acked_at)` with an index on `(recipient, seq)`).
2. **Add an SSE endpoint** with Nest's `@Sse()` decorator and an RxJS `Observable` built from `onMessage()`.
3. **Scale out**: run two instances behind nginx, add `@socket.io/redis-adapter`, and move the `EventEmitter` in `MessagesService` to Redis pub/sub so a message sent on instance A reaches a socket on instance B.
4. **Per-device cursors**: today, acking from one tab removes the message for every tab. Track acks per `(user, device)` so a phone and a laptop both get the message.
5. **Push notifications** for users who are truly offline: if `presence.isOnline(to)` is false, enqueue an FCM / APNs notification. The push only says "you have a message"; the app then syncs over the normal channel to fetch it.
6. **Authentication**: replace `handshake.auth.userId` with a JWT verified in a guard or in `handleConnection`.
7. **Expiry and limits**: cap the inbox size, expire messages after N days, and add rate limiting to `POST /messages`.
8. **Read receipts**: a second ack type ("seen") sent back to the original sender, which is itself a message that may need offline delivery.
