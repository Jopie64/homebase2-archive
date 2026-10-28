# Scheduling

Run the archiver once an hour (or once a day) — new recordings are picked up automatically and nothing
is downloaded twice. A run that starts while another is still busy exits immediately because of the
lock in the state directory, so a short interval is harmless.

All examples assume the project lives in `/opt/homebase2-archive`. Adjust paths.

## Linux: systemd timer (recommended)

`/etc/systemd/system/homebase2-archive.service`

```ini
[Unit]
Description=Archive eufy HomeBase 2 recordings
After=network-online.target

[Service]
Type=oneshot
User=media
Group=media
WorkingDirectory=/opt/homebase2-archive
ExecStart=/opt/homebase2-archive/run.sh
StateDirectory=homebase2-archive
```

`/etc/systemd/system/homebase2-archive.timer`

```ini
[Unit]
Description=Hourly eufy HomeBase 2 archive

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now homebase2-archive.timer
journalctl -u homebase2-archive.service -n 50
```

`StateDirectory=` creates `/var/lib/homebase2-archive` owned by the service user — set
`"stateDir": "/var/lib/homebase2-archive"` in `config.json` to match.

## Cron

```cron
17 * * * * /opt/homebase2-archive/run.sh >> /var/log/homebase2-archive.out 2>&1
```

Cron gives a minimal environment. If `node` is not on cron's `PATH`, either use a full path in
`config.json` (`"nodeBin": "/usr/local/bin/node"`) or export `PATH` in a wrapper script.

## Synology DSM (Task Scheduler)

DSM has no user crontab, and background processes started over SSH do not always survive the session —
the built-in task scheduler is the reliable route, and it runs without an SSH connection.

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
2. **General**
   - Task name: `homebase2-archive`
   - User: an account that owns the archive directory (do **not** use `root`; files should keep their
     owner and permissions)
3. **Schedule**
   - Run on the following days: Daily, *Repeat hourly* (first run at a quiet time, e.g. 07:05)
   - Hourly while backfilling: 24 runs × `maxClips` per day
4. **Task Settings**
   - Optional: *Send run output by e-mail* (only on unexpected stop). The script already logs to
     `<stateDir>/sync.log`, so DSM logging is optional.
5. **Task** → user-defined script:

```sh
/volume1/homes/<user>/homebase2-archive/run.sh
```

6. Save, then right-click the task → **Run** to verify.

If Node is not on the task's `PATH` (common on DSM), pass it explicitly — either in `config.json`:

```json
{ "nodeBin": "/volume1/homes/<user>/node/bin/node" }
```

or from the task script:

```sh
export HBA_NODE_BIN=/volume1/homes/<user>/node/bin/node
/volume1/homes/<user>/homebase2-archive/run.sh
```

### Notes specific to DSM

- `crontab` does not exist for regular users; `root` cron would need a stored sudo password. Use Task
  Scheduler.
- DSM mounts `/tmp` as `noexec`.
- Synology's stock ffmpeg has no `h264` demuxer — put a static build somewhere persistent (e.g.
  `~/.local/bin/ffmpeg`) and point `ffmpeg` in `config.json` at it.

## Docker / container

There is no published image. A container works if it has Node 24 and a full ffmpeg, and it must share
the host network: the station is reached directly over P2P (UDP), not through the cloud.

```sh
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm install --omit=dev --no-audit --no-fund && node scripts/patch-sdk.mjs
ENTRYPOINT ["/app/run.sh"]
```

```sh
docker run --rm --network host \
  -v /mnt/photos/doorbell:/archive \
  -v /srv/homebase2-archive/state:/state \
  -v /srv/homebase2-archive/credentials:/credentials:ro \
  -e HBA_OUT_DIR=/archive \
  -e HBA_STATE_DIR=/state \
  -e HBA_CREDENTIALS=/credentials \
  homebase2-archive
```

## Checking a scheduled setup

```sh
tail -20 ~/.local/state/homebase2-archive/sync.log      # last run
tail -20 ~/.local/state/homebase2-archive/backfill.log  # backfill progress
node stats.mjs                                          # totals
node verify.mjs                                         # state vs disk
```
