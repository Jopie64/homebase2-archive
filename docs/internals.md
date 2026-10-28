# Internals: how the HomeBase 2 behaves

Everything below was established by experiment against a HomeBase 2 (`T8010`) with a `T8210` doorbell.
It is written down because none of it is documented anywhere and every point below caused real bugs.

## Record list pagination

`queryRecordPage({ startTime, count })` returns recordings newest-first.

- `start_time: "0"` means "the newest page".
- The cursor for the next page is the **`yyyyMMddHHmmss` form of the oldest row** of the page you just
  received. Passing the raw `start_time` string from the station (`"2026-10-16 22:53:41"`) is parsed
  incorrectly and silently jumps months back.
- `count` is honoured (100 in, 100 out), but **every row appears twice in a reply**. Deduplicating on
  `record_id` is mandatory; without it the count comes out halved.

## Why the index is always complete

A tempting optimisation is to stop paging as soon as a page is fully archived. It is wrong: during a
partial backfill the newest pages are exactly the ones already done, while the unarchived history sits
below them. An early stop would therefore never reach old recordings. The full index costs a minute or
two per run and is the safe choice.

If a page fails, the index must fail loudly rather than return a truncated list — a partial index makes
the tool report "nothing to do" while thousands of recordings are still pending. Pages are retried
three times, then the run aborts.

## The level-2 handshake

The station answers database queries only after the second crypto handshake has completed
(`session.level2Key` / `session.level2Ready`, about a second after connecting). Query too early and you
get `sent no complete history_record_info`. A fresh session sometimes reports level-2 ready while the
first query still times out, which is why index building retries with a reconnect.

The station also serves **one database reader at a time**. Do not run a second query (or a probe script)
next to a sync.

## Storage paths and channels

Recordings live on the station as `/media/mmcblk0p1/Camera<NN>/h265_<yyyymmddhhmmss>.dat`.

- Download with `CMD_DOWNLOAD_VIDEO` (1024) and the **complete `storage_path`**, including `h265_`
  prefix and `.dat` suffix. Passing the bare 14-digit name builds a valid path for current recordings
  and a broken one for archived ones — that is upstream issue
  [#526](https://github.com/mega-yfue/eufy-sdk/issues/526), fixed in `0.6.0-beta.12`.
- The channel number comes from the `Camera<NN>` part of the path.
- A few list rows are unusable (no `frame_num`, or a path that does not match). They are filtered out
  before anything is downloaded.

## Ciphers, and why old recordings cannot be decrypted

Each row carries a `cipher_id`. Only the **low byte** resolves to a key record
(`(cipher_id & 0xff)`); the full 32-bit value returns an empty key list. Keys come from
`get_ciphers` (`/v3/app/cipher/get_ciphers`).

Measured on one station (roughly 8,400 recordings, spanning 2022-12 → now):

| cipher | rows | key record returned by the cloud | result |
|---|---|---|---|
| `98` | ~2,200 (recent) | `ecc_private_key` (64 hex chars) + `private_key` | **works** — decrypted and verified |
| `175` | ~675 | only an RSA `private_key`; `ecc_private_key` empty | cannot be used: the released decoder needs a 32-byte P-256 key |
| `1` | ~5,400 (oldest) | **no record at all** | nothing to decrypt with |
| `0` | ~173 | no `cipher_id` field at all | unusable rows |

The keys are not on the station either: a `readDatabase` (FULL_TABLE) on the plausible tables
(`cipher_info`, `cipher`, `station_cipher`, `key_info`, …) is refused with `-1001`; only the history
query (`10017`) works.

What the frames of an old (`cipher 1`) recording look like: frame 0 is ECIES-encrypted (no Annex-B
start code), while the frames after it are plaintext. Without a key, a decoder can produce most frames
but never a keyframe or audio — the result is unusable. This is a eufy-side limitation, not a bug in
this tool: those rows are recorded as `skipped` with the reason, and `--force` will not change that.

If a key ever becomes available for one of these ciphers, the file names (`h265_…`) and the plaintext
slices suggest the old recordings are **HEVC** rather than H.264, so a decrypt of those would also need
a different muxing route (`-f hevc`). That has not been verified.

## Session death

A P2P session survives roughly **50 downloads**, then transfers start failing with
`the station sent nothing within 20000 ms`. The correct reaction is to close the session, connect again,
wait for level-2 and retry the same recording — not to abort the run. This tool does that after
`recoverAfter` consecutive session errors, and gives up on the run only when recovery keeps failing.

Throughput is about **6 seconds per clip**: the station sends faster than realtime, but the handshake
and teardown per recording dominate.

## Logins are rate-limited

The eufy cloud counts logins per account/device identity within a time window. A burst of logins
(development probes each logging in separately) produces `Hit max login limit` (`200/100028`) and locks
the account out of new logins for up to 24 hours — the official app gets the same error.

Hence: one login, then store the session token on disk (`FileSessionStore` in the SDK, `session.json`
here) and reuse it for as many runs as the token lives. A run with a valid token performs **no** login
at all. When the token finally expires, the next run logs in once and stores the new one.

Corollary for development: never let each experiment log in on its own. Reuse one long-lived session.

## Filesystem traps

- **Temporary files belong in the output directory.** State and archive are often on different
  filesystems (separate btrfs subvolumes, bind mounts, network shares), where `rename()` fails with
  `EXDEV`. Write to a `.tmp-*` file next to the target, then rename within the same directory; a
  copy+unlink fallback covers the remaining cases.
- **State must be written atomically** (write to `.tmp`, then rename), otherwise a crash mid-write
  loses the entire archive bookkeeping.

## ffmpeg

The station sends elementary streams, so ffmpeg needs the `h264` **demuxer** to read raw annex-B
H.264. Synology's own `/usr/bin/ffmpeg` (4.1.x, also the MediaServer copy) does not have it: muxing
fails with `Unknown input format: 'h264'`. The tool checks for the demuxer at startup and refuses to
run otherwise — thousands of silently saved `.h264` files would be worse than a clear error.

Muxing itself is a stream copy, no re-encoding:

```sh
ffmpeg -f h264 -i clip.h264 [-f aac -i clip.aac] -c copy -movflags +faststart clip.mp4
```

`-movflags +faststart` puts the index at the front of the file so it plays while streaming (Photos,
browsers, phones).

## Background processes on a NAS

On some NAS units a `nohup` process does not reliably survive the SSH session that started it, while
`setsid` does. For long backfills prefer the task scheduler of the machine, or a `setsid`-detached
`backfill.sh`.
