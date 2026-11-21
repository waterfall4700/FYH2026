# Fare Dodgers — Massively Multiplayer Pac-Man (KCL Hackathon)

A London-themed Pac-Man where the whole audience plays at once. Some players are
Pac-Men ("fare dodgers"), the rest are ghosts ("ticket inspectors").

## Joining & platform
- Join via QR code or link → web page (no install).
- **Username required** on join (unique per game, 1–16 chars).
- Works on phones (swipe + on-screen D-pad) and laptops (arrow keys / WASD).
- Each player sees the game on **their own screen only** (no shared projector view).
  - Camera follows the player's character (zoomed in).
  - Mini-map shows the full maze.
- Tech: **Node.js + Socket.IO** server (authoritative game state), **HTML5 Canvas** client.

## Lobby & round flow
- Players join a lobby showing a live player count.
- **Host page** with a Start button → server assigns roles, builds the map, starts the round.
- **No time limit**: the round ends only when one side wins.
- Late joiners spectate the current round and join the next one.
- After the round: leaderboards → back to lobby → host can start the next round.

## Teams & balance
- Roles are **random and auto-balanced** each round.
- **Pac-Men = max(1, round(40% of players))**; everyone else is a ghost.
  - 100 players → 40 Pac-Men / 60 ghosts.
- Speeds: Pac-Man 1.0×, ghost 0.9×, frightened ghost 0.5×.
- Spawns: Pac-Men spread around the maze edges; ghosts in multiple ghost houses (stations).

## Win conditions
- **Pac-Men win** when the team eats every pellet (shared progress bar).
- **Ghosts win** when every Pac-Man has been eliminated.
- Caught Pac-Man → **out for the round, spectates** (camera can follow teammates).

## Power pellets
- Eating one turns all ghosts frightened (blue) for ~6 s.
- Eaten ghost → returns to its ghost house, respawns after 5 s.

## Sudden death
- When fewer than **5% of pellets remain**, the remaining pellets flash on everyone's
  mini-map (prevents stalemates / ghosts camping hidden pellets).

## Map size (scales with player count; may be tuned during development)
Built from classic-sized 28×31 blocks.

| Players | Grid               | Ghost houses | Power pellets |
|---------|--------------------|--------------|---------------|
| 2–12    | 28×31 (1 block)    | 1            | 4             |
| 13–40   | 56×31 (2 blocks)   | 2            | 8             |
| 41–80   | 56×62 (4 blocks)   | 4            | 16            |
| 81–150  | 84×62 (6 blocks)   | 6            | 24            |

~1,500 pellets at 100 players (~37 per Pac-Man).

## Theme: London / KCL
- Maze walls drawn as coloured **Tube lines** on a dark background.
- Pellets = **Oyster coins**; power pellets = **cups of tea**.
- Pac-Men keep the chomping shape, styled as a **Tube roundel**.
- Ghosts keep the ghost silhouette, wearing **ticket-inspector caps**.
- Ghost houses drawn as **stations**.

## Player identity
- Each character has a **unique auto-assigned look**: colour × accessory
  (e.g. 12 colours × 10 accessories such as bowler hat, scarf, glasses, headphones → 120+ combos).
- Username **name tag** floats above every character.
- Your own character has a **glowing ring** so you can find yourself instantly.

## Leaderboards (shown at end of round, by username)
Two separate boards, ranked by points; raw stats shown alongside.

**Pac-Men**
- +10 per Oyster coin
- +50 per cup of tea (power pellet)
- +200 per ghost eaten

**Ghosts**
- +300 per Pac-Man caught
- −50 each time eaten
