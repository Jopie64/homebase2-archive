# homebase2-archive

Archive the recordings of a **eufy HomeBase 2** to plain **MP4** files, organised in month folders, on
your own machine — no app, no cloud subscription, no vendor lock-in for your footage.

```
/volume1/photo/doorbell/2026-10/2026-10-26_18-02-57.mp4
```

It runs on a NAS, a Raspberry Pi, a small server or a desktop, and it is designed to be scheduled: keep
a local archive, feed it to Synology Photos / Immich / Jellyfin, or just be independent of the eufy app.

> **Status:** the download path is verified end-to-end against a HomeBase 2 (`T8010`) with an eufy
> doorbell (`T8210`): thousands of recordings archived, each one decode-checked with ffmpeg. Other
> stations/cameras that store their recordings on a HomeBase should work too, but are untested — please
> open an issue with your model if you run it on different hardware.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Credentials](#credentials)
- [Configuration](#configuration)
- [Usage](#usage)
- [Scheduling](#scheduling)
- [Verifying your archive](#verifying-your-archive)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Legal notice](#legal-notice)
- [License](#license)

---

## Why this exists

A HomeBase 2 keeps its recordings on an internal card and the eufy app is the only supported way to
watch or export them. Exporting a year of doorbell footage through an app is painful, and if the
HomeBase fills up or dies, the footage is simply gone.

The protocol is not documented anywhere. What this project does is the sum of what had to be
discovered to make a *reliable, resumable* exporter:

- the record list uses a timestamp cursor and returns **every row twice** (dedupe is mandatory);
- the station answers database queries only **after a level-2 crypto handshake**;
- recordings are encrypted with **several different ciphers over time**, each with its own key record;
- the P2P session **dies after a few dozen downloads** and has to be re-established mid-run;
- eufy rate-limits **logins**, so one login has to serve many runs (the session is stored on disk).

## How it works

```
login (once, session stored) ─► P2P session ─► level-2 handshake
        │
        ├─► page the record list (cursor = oldest timestamp of the previous page, dedupe on record_id)
        │
        └─► for each pending recording:
              CMD_DOWNLOAD_VIDEO (full storage_path) → frames → decrypt (cipher ECC key)
              → ffmpeg -c copy → <outDir>/YYYY-MM/YYYY-MM-DD_HH-MM-SS.mp4 → state.json
```

Every clip is recorded in `state.json` after it is fully written, so an interrupted run simply
continues where it stopped. A lock directory prevents two runs from fighting over the station.

The details — pagination quirks, cipher IDs, session death, filesystem traps — are in
[docs/internals.md](docs/internals.md).

## Requirements

| | |
|---|---|
| **Node.js** | 24.5 or newer (developed on 24/26) |
| **ffmpeg** | any build that can read raw H.264 (`ffmpeg -demuxers \| grep h264`). **Distro and Synology stock builds often cannot** — use a static build, see [Installation](#installation) |
| **A eufy account** | with the HomeBase 2 on it, and the station reachable on your LAN |
| **Disk space** | roughly 200 KiB per recording; a year of doorbell clips is a few GiB |

The station is contacted over the local network (P2P); the cloud is only used for login, the device list,
the cipher keys and (optionally) nothing else. No cloud subscription is required.

## Installation

```sh
git clone <this repository> homebase2-archive
cd homebase2-archive

cp config.example.json config.json
$EDITOR config.json            # at minimum: outDir, and up to you: stationSn, ffmpeg

./install.sh
```

`install.sh` checks the Node version, installs the SDK, applies a small export patch (see
[Why the patch?](#why-the-patch)), creates the state and output directories and reports where it will
write.

### ffmpeg

The raw streams that come off the station are elementary H.264/AAC, so ffmpeg must have the `h264`
**demuxer**. Many vendor builds do not. A static build always does:

```sh
# x86_64 Linux example
curl -fsSL -o /tmp/ff.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xJf /tmp/ff.tar.xz
mkdir -p ~/.local/bin
cp /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe ~/.local/bin/
```

Then set `"ffmpeg": "~/.local/bin/ffmpeg"` in `config.json`. If the muxer cannot read H.264 the run
refuses to start, instead of quietly writing thousands of `.h264` files.

### Why the patch?

The SDK (`@mega-yfue/eufy-sdk`) contains the frame decoder but does not export it
(upstream issue [#526](https://github.com/mega-yfue/eufy-sdk/issues/526)). `scripts/patch-sdk.mjs`
appends one export line to the installed bundle. It is idempotent and runs after every `npm install`.
A future SDK release that exports the decoder — or a host application using `camera.downloadRecording()`
— makes it unnecessary.

## Credentials

Create the credentials file (default `~/.config/homebase2-archive/credentials`, `chmod 600`):

```sh
EUFY_EMAIL=you@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=NL
```

`COUNTRY` is the two-letter country code of your eufy account (default `NL`); the `EUFY_` prefix is
optional and kept for compatibility.

Notes:

- **Logins are rate-limited by eufy.** The first run logs in once and stores the session token in
  `session.json`; later runs reuse it and never touch `/passport/login`. Do not delete the state
  directory casually, and never run several copies of this tool against the same account.
- If you change your eufy password, delete `session.json` and let the next run log in again.
- `session.json` is a bearer token: keep the state directory at mode `700` and never commit or share it.

## Configuration

Everything lives in `config.json` next to the code (git-ignored — copy it from `config.example.json`).
Any setting can be overridden per run by an environment variable, which is handy in containers:

```sh
HBA_OUT_DIR=/mnt/doorbell ./run.sh --limit 5
```

| Setting | Env override | Default | Meaning |
|---|---|---|---|
| `credentialsFile` | `HBA_CREDENTIALS` | `~/.config/homebase2-archive/credentials` | account credentials |
| `stationSn` | `HBA_STATION_SN` | *(empty)* | HomeBase serial; empty = auto-detect if the account has exactly one |
| `outDir` | `HBA_OUT_DIR` | `~/clips` | archive root; a `YYYY-MM` folder is created per month |
| `stateDir` | `HBA_STATE_DIR` | `~/.local/state/homebase2-archive` | state, lock, session, index and logs |
| `ffmpeg` | `HBA_FFMPEG` | `ffmpeg` | muxer binary (name on `PATH` or absolute path) |
| `nodeBin` | `HBA_NODE_BIN` | `node` | Node binary used by `run.sh`/`install.sh` (for NAS setups where node is not on `PATH`) |
| `maxClips` | `HBA_MAX_CLIPS` | `300` | recordings archived per run |
| `pageSize` | `HBA_PAGE_SIZE` | `100` | rows per record-list page |
| `since` | `HBA_SINCE` | *(empty)* | only recordings from this day on (`yyyyMMdd`) |
| `clipTimeoutMs` | `HBA_CLIP_TIMEOUT_MS` | `90000` | timeout per download |
| `drainTimeoutMs` | `HBA_DRAIN_TIMEOUT_MS` | `60000` | how long to wait for a stalled transfer to drain |
| `maxAttempts` | `HBA_MAX_ATTEMPTS` | `3` | attempts before a failed clip is left alone (until `--force`) |
| `recoverAfter` | `HBA_RECOVER_AFTER` | `3` | consecutive session errors before reconnecting |
| `maxRecoveries` | `HBA_MAX_RECOVERIES` | `40` | reconnects allowed per run |
| `level2TimeoutMs` | `HBA_LEVEL2_TIMEOUT_MS` | `60000` | how long to wait for the crypto handshake |

Check what is actually in effect — including which config file was found:

```sh
./run.sh --print-config
```

`backfill.sh` has two extra knobs: `HBA_BATCH` (clips per round, default 400) and `HBA_MAX_ROUNDS`
(default 60).

### Output layout

```
<outDir>/2026-10/2026-10-26_18-02-57.mp4
```

Files are named after the recording's start time on the station. A collision (two recordings in the
same second) gets a short id suffix instead of overwriting.

If muxing fails, the raw streams are kept as `.h264` (+ `.aac`) next to the archive rather than losing
the footage; `state.json` records which format each clip has.

## Usage

```sh
./run.sh --list              # what is on the station that is not archived yet (downloads nothing)
./run.sh --limit 3           # small test run
./run.sh                     # regular run: up to maxClips new recordings, newest first
./run.sh --all               # no limit for this run
./run.sh --since 20260101    # only from this day on
./run.sh --index-only        # just refresh stateDir/index.json
./run.sh --force             # retry failed/skipped recordings too
```

`--list` and every normal run build the full station index first: expect a **minute or two per run**
for a few thousand recordings. That is deliberate — see [internals](docs/internals.md#why-the-index-is-always-complete).

### First backup of the whole history

```sh
setsid ./backfill.sh < /dev/null > /dev/null 2>&1 &     # or nohup, or a systemd unit
tail -f ~/.local/state/homebase2-archive/backfill.log
```

`backfill.sh` runs rounds of `HBA_BATCH` recordings, each round as a fresh process (so a dead P2P
session cannot stop the backfill), and stops when there is nothing left. Expect roughly **6 seconds per
recording** — about 14 hours for 8,000 clips.

## Scheduling

Run it hourly; new recordings are picked up automatically. See [docs/scheduling.md](docs/scheduling.md)
for a **Synology Task Scheduler** task, **cron**, and a **systemd timer**.

```cron
17 * * * * /opt/homebase2-archive/run.sh >> /var/log/homebase2-archive.out 2>&1
```

The tool has its own lock: a run that starts while another is still busy exits immediately, so a short
interval is harmless.

## Verifying your archive

```sh
node verify.mjs                  # state vs disk: missing files, size differences, months
node verify.mjs --probe=5        # decode 5 random clips with ffmpeg
node verify.mjs --list-failures  # what failed, how often
node verify.mjs --list-skipped   # what was skipped, and why
node stats.mjs                   # totals: clips, range, size, skip reasons
```

`verify.mjs` exits non-zero when a recorded file is gone or has an unexpected size, so it works as a
health check in monitoring.

## Troubleshooting

| Message | Meaning / what to do |
|---|---|
| `eufy login limit reached` | Too many logins from this network recently. The session file was dropped; wait (minutes to a day) and run again. Do not retry in a loop. |
| `level-2 handshake timeout` | The station did not finish the crypto handshake — offline, busy, or not reachable on the LAN. Also happens when a run starts seconds after the previous one ended; the tool retries three times, 15 s apart, before giving up. |
| `no P2P session to the HomeBase` | Connection failed — check that the station is powered and on the same network; verify `stationSn`. |
| `several HomeBases found` | Set `stationSn` in `config.json`. |
| `incomplete index: page N failed` | The station dropped a database query mid-index. Run again; the index is retried three times per run. |
| `no ECC key for cipher N` | Expected for some older recordings — the cloud has no key for that cipher, so no client can decrypt them. Recorded as `skipped`. See [internals](docs/internals.md#ciphers-and-why-old-recordings-cannot-be-decrypted). |
| `session keeps failing despite recovery` | The station stopped answering. The run exits cleanly; the next run continues. |
| `muxer ... has no h264 demuxer` | Point `ffmpeg` at a full build (see [ffmpeg](#ffmpeg)). |
| `decodeRecording is missing` | Run `npm run patch` (or `./install.sh` again). |
| Run stops with a lock message | A previous run died. Remove `sync.lock` from the state directory (a lock older than 6 h is cleaned up automatically). |
| `sent no complete history_record_info` | The station serves one database reader at a time; never run two queries/probes next to a sync. |

Logs: `<stateDir>/sync.log` (rotated at 5 MB) and `<stateDir>/backfill.log`.

## Known limitations

- **The P2P session is fragile.** It dies after a few dozen downloads; the tool reconnects and retries,
  but throughput stays around one clip per ~6 seconds.
- **Older recordings may be undecryptable.** The station has used at least four cipher IDs over the
  years; for the oldest ones eufy's cloud returns no key at all. Those are skipped with a clear reason.
  Nothing client-side can fix that.
- **The station's record list is the only source.** Recordings that were deleted from the station are
  not recoverable through this tool.
- **HomeBase 2 only.** Newer HomeBase 3 / S380 stations use a different local storage model and are not
  supported.
- **Unofficial API.** eufy can change the protocol at any time; when that happens this project will
  need a fix.

## Legal notice

This is an unofficial tool. It is not affiliated with, endorsed by or supported by eufy or Anker. It
only accesses the account you own, using the same endpoints the official app uses. Check your local
laws and the eufy terms of service before using it; you are responsible for how you use it. The
authors take no responsibility for blocked accounts, lost data or damaged devices.

## License

MIT — see [LICENSE](LICENSE).
