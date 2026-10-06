# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability"
feature on this repository rather than opening a public issue.

## What JobTrace stores, and what is sensitive

- **Auth profiles are secrets.** An auth profile is a saved browser session
  (cookies and local storage) written to `DATA_DIR/auth/<id>.json` with file mode
  `0600`. Anyone who can read that file can act as you on that site. The data
  directory is gitignored; never commit or share it. Auth state is never logged,
  never included in recording exports, and never sent to the optional AI plugin.
- **Passwords are never stored.** The recorder does not capture values typed into
  password, payment-card, or one-time-code fields. Log in through an auth profile.
- **The API is local by default.** It binds to `127.0.0.1`. Binding to any other
  host requires `API_TOKEN`.
- **The AI fallback plugin is off by default.** When enabled it sends a trimmed,
  sanitized page snapshot (no input values, no cookies) to the Claude API.

## What JobTrace will not do

JobTrace does not solve CAPTCHAs, use stealth plugins, spoof browser fingerprints,
or otherwise try to evade bot detection. When it meets a bot wall it stops, marks
the run `blocked`, and saves a screenshot. It respects `robots.txt` by default.
Please keep request volumes low and respect each site's terms of use.
