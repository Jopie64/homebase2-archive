# Security

This tool talks to your own eufy account and stores two kinds of secrets in your state directory:

| File | What it is | Handling |
|------|------------|----------|
| the credentials file (`~/.config/homebase2-archive/credentials` by default) | account e-mail, password, country code | `chmod 600`, never committed, never logged |
| `session.json` in the state directory | a live login token for that account | written `chmod 600`, **treat it as a password** |

`state.json` and `index.json` are not secrets in the cryptographic sense, but they do contain serial
numbers, storage paths and timestamps of your recordings. Treat them as private.

## Rules

- Never paste the contents of the credentials file or `session.json` into an issue, a discussion or a
  pull request. Redact serial numbers too.
- The state directory is created with mode `700` by `install.sh`. Keep it that way.
- Revoke access by changing your eufy account password; then delete `session.json` so a fresh login is
  made on the next run.

## Reporting a vulnerability

Open a private security advisory on this repository ("Security" → "Advisories" → "Report a
vulnerability"). Please do not open a public issue for anything that could expose credentials or
session tokens.
