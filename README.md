# Fare Dodgers

London-themed, massively multiplayer Pac-Man for a live audience. 40% of players are
**fare dodgers** (eat every Oyster coin), 60% are **ticket inspectors** (catch every dodger).
Full design: `.idea/plan.md`.

## Run

Terminal 1, the game server:

```bash
npm install        # first time only
npm start          # prints the host link with ?key=...
```

Terminal 2, a public link (needed when phones can't reach your laptop over Wi-Fi):

```bash
cloudflared tunnel --url http://localhost:3000   # prints https://xxxx.trycloudflare.com
```

Open `https://xxxx.trycloudflare.com/host?key=<key>` on the laptop. The QR code on that page
uses whatever address the host page was opened from, so players can scan it from anywhere.

Environment variables:

| Var          | Default | Purpose                                         |
|--------------|---------|-------------------------------------------------|
| `PORT`       | `3000`  | HTTP port                                       |
| `HOST_KEY`   | random  | Fixed secret for the host page                  |
| `PUBLIC_URL` | (auto)  | Force the join URL shown in the QR code         |

## Test with bots

```bash
npm run bots -- 100          # 100 wandering bot players on localhost:3000
```

## Controls

- Press a direction once and you keep moving that way until a wall. Pressing early
  queues the turn for the next junction, like the arcade game.
- Laptop: arrow keys / WASD
- Phone: on-screen D-pad, or swipe anywhere

## Layout

- `server.js`: Express + Socket.IO, QR code, host key
- `src/maze.js`: procedural, mirrored, dead-end-free maze that scales with player count
- `src/game.js`: authoritative game loop (20 Hz), roles, scoring, win rules, sudden death
- `public/`: player client (`client.js`), host page (`host.js`), shared drawing (`draw.js`)
