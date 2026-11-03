# Active multiplayer signalling server

Multiplayer in Active is one host and up to 5 guests, connected peer to peer over WebRTC between Active windows. This server is only the meeting point. It:

- creates rooms and hands the host a secret token,
- introduces guests to the host, who admits or denies each one,
- relays opaque signalling blobs (WebRTC offers, answers and ICE candidates, encrypted by the clients) between the host and admitted guests,
- hands out short-lived TURN credentials.

It never sees app traffic, which goes over the WebRTC data channels, and it never reads the `data` it relays.

There are two runtimes, and both use the same room logic (`src/room.ts`):

| | Where | Use |
|---|---|---|
| `src/worker.ts` | Cloudflare Worker + one Durable Object per room (WebSocket Hibernation API) | production |
| `src/local.ts` | Node `http` + `ws`, rooms in memory, `127.0.0.1:8787` | testing Active locally without Cloudflare |

## Local development

Requires Node 22.18 or later. The TypeScript runs directly through Node's built-in type stripping, so there is no build step.

```sh
cd active/multiplayer-server
npm install
npm run dev:local          # http://127.0.0.1:8787  (PORT=9000 npm run dev:local to change)
npm test                   # unit tests for room.ts and turn.ts, plus an end-to-end test of local.ts
npm run typecheck          # tsc for the Worker (workers-types) and for the Node side
```

Locally, `GET /turn` returns `{ "iceServers": [] }`, because WebRTC on one machine needs no STUN or TURN.

## Deploying to Cloudflare

Nothing has been deployed yet. To deploy:

1. **Create a TURN key.** In the Cloudflare dashboard, go to **Realtime > TURN Server** and create a key. Note its **Key ID** and **API token**; the token is shown only once.
2. **Log in:** `npx wrangler@4 login`
3. **Set the secrets:**
   ```sh
   npx wrangler@4 secret put TURN_KEY_ID
   npx wrangler@4 secret put TURN_KEY_API_TOKEN
   ```
   Without them, `/turn` returns public STUN only. That works for most connections but not for peers behind strict NATs.
4. **Deploy:** `npm run deploy` (runs `npx wrangler@4 deploy`). The Durable Object class and its migration come from `wrangler.toml`. The Worker is served at `https://active-multiplayer.<your-subdomain>.workers.dev`, and that becomes the server base URL in Active.
5. Optional: `npm run dev` runs the real Worker locally under wrangler. Put the secrets in a git-ignored `.dev.vars` file for that.

Check current Cloudflare pricing for Workers, Durable Objects and TURN (free allowance, then per GB) before deploying.

### TURN API

`GET /turn` calls `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` with `Authorization: Bearer $TURN_KEY_API_TOKEN` and the body `{"ttl": 86400}`. This is the endpoint in Cloudflare's current docs, and it returns `201` with `{ "iceServers": [ … ] }`.

The older `…/credentials/generate` endpoint returns a single `iceServers` object, and that shape is accepted too. Port-53 URLs are removed because browsers block them (Cloudflare's docs warn they only stall ICE). `stun:stun.cloudflare.com:3478` is always included. If the API fails, the response falls back to STUN only.

## HTTP API

CORS is fully open (`Access-Control-Allow-Origin: *`), because Active calls these routes from a desktop renderer.

| Route | Result |
|---|---|
| `POST /rooms` | `201 { roomId, hostToken }`. `roomId` is 10 random lowercase base32 characters. `hostToken` is 32 random bytes in base64url. The server stores only the token's SHA-256 hash. |
| `GET /rooms/<roomId>/ws?role=host&token=<hostToken>` | WebSocket: the host's connection. |
| `GET /rooms/<roomId>/ws?role=guest&name=<urlencoded name>` | WebSocket: a guest's connection. Names are trimmed, stripped of control characters and capped at 64 characters. |
| `GET /turn` | `{ iceServers }`, ready to pass to `new RTCPeerConnection({ iceServers })`. |

Refused connections (bad token, unknown room, full room, and so on) still complete the WebSocket upgrade. The server then sends `{ type: 'error', message }` and closes, because a browser WebSocket can't read an HTTP status.

## WebSocket protocol

All frames are JSON text. Binary frames are rejected with an error.

**Server to host**
- `{ type: 'join-request', peerId, name }`: a guest wants in.
- `{ type: 'peer-left', peerId }`: a pending or admitted guest disconnected on its own. This is not sent after the host's own deny or kick.
- `{ type: 'signal', from: peerId, data }`

**Host to server**
- `{ type: 'admit', peerId }`: admits a pending guest.
- `{ type: 'deny', peerId, reason? }`: refuses a pending guest. The guest is closed. `reason` is capped at 200 characters.
- `{ type: 'kick', peerId }`: removes any guest, pending or admitted. The guest is closed.
- `{ type: 'signal', to: peerId, data }`: only to admitted guests.

**Server to guest**
- `{ type: 'pending' }`: sent on connect, while the guest waits for the host.
- `{ type: 'admitted', peerId }`
- `{ type: 'denied', reason? }`, then close.
- `{ type: 'kicked' }`, then close.
- `{ type: 'signal', from: 'host', data }`
- `{ type: 'host-left' }`, then close.

**Guest to server**
- `{ type: 'signal', data }`: only after `admitted`. Always goes to the host. Guests can't address each other.

**Server to anyone**
- `{ type: 'error', message }`: for a malformed, oversized (over 64 KB), unknown or unauthorised message. The socket stays open for these errors. Connection refusals close it.

`data` is any JSON value. It is relayed as-is and never inspected.

### Close codes

| Code | Meaning |
|---|---|
| 4000 | bad connection parameters |
| 4001 | invalid host token |
| 4003 | denied |
| 4004 | room not found, ended, or the host isn't connected yet |
| 4005 | kicked |
| 4009 | the room already has a host |
| 4010 | host left |
| 4029 | room full (5 guests, pending and admitted together) |

### Room lifetime

- `POST /rooms` creates the room. If no host connects within 10 minutes, the room is deleted.
- Guests can join only while the host is connected.
- Only one host connection is allowed at a time. A second connection is refused with 4009, even with the right token.
- **When the host's socket closes, the room ends for good.** Every guest gets `host-left` and is closed, and the token stops working: a later host connection gets "room not found". To host again, call `POST /rooms` for a new room and invite link. This matches the design rule that a session ends when the host leaves.
- WebRTC connections that are already up don't depend on this server. Even so, Active treats a lost host socket as the end of the session.

## Not done yet

- Rate limiting of `POST /rooms` and of connection attempts. Cloudflare's WAF or rate-limiting rules can cover this at first.
- Reconnects (a guest drops and rejoins with the same identity).
