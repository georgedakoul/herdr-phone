# Intent: slow down wrong passwords and tell me when it happens

**Problem.** The token is now a fixed password George picked, so it lives in his head and in
his phone's keychain instead of being regenerated every run. That is the point, but it makes
guessing worth trying: a chosen password is weaker than 24 random bytes, and `POST /login`
currently accepts wrong guesses as fast as a caller can send them, with no delay and no record.
Anyone already on the tailnet can sit there guessing. George's own words: "with a timer and
email message on someone tried to many times to enter and got wrong password".

**Outcome.** Repeated wrong passwords get slower until guessing is pointless, and George gets
an email when it happens. Specifically:

- After a few failures from the same device, `POST /login` starts refusing for a growing wait,
  capped so George is never locked out for long.
- The correct password clears the wait immediately.
- When the wait first trips, one email lands, naming the tailnet device and account behind the
  attempts, the count, and the time. Repeat attempts inside the same cooldown do not send more
  email.
- The right password still works first try, every time, with no new step for George.

**Who and what it touches.** Only herdr-phone, and only the login path. `src/app.js` gains the
throttle check on `POST /login`. New modules for the counter and for sending the mail. New
tests. The README grows a section on the new environment variables. Nothing about the
agent, pane, layout, worktree or action routes changes. No change to how the cookie works or
how long it lasts.

Outbound: one SMTP session to `smtp.gmail.com:465` when an alert fires, and only then, sending
from the operator's own Gmail account to an address they choose, which in practice is the same
address. The app makes no other network calls today and this does not change that for normal
use.

**Constraints.**

- No dependencies. The repo has no `dependencies` key and keeps it that way, so the SMTP
  conversation is written directly against `node:tls` rather than pulling in a mail library.
- Gmail, with an app password George generates for herdr-phone alone, not the one
  `mcp-dashboard` already uses. Revoking one must not break the other.
- The account, the app password and the destination address all come from environment
  variables, so no address of George's lands in the tree. This repo carries no name, path or
  secret from this machine. None of the three is committed, printed, or written to a file,
  same rule as the token, and herdr-phone never reads another repo's `.env`.
- The alert is optional. With no app password set, the throttle still works and the app starts
  normally with a line saying alerts are off. It must never be possible for a mail failure to
  break or delay a login: the send happens after the response goes out, and a failure is
  logged and swallowed.
- No hard lockout. Anyone on the tailnet must not be able to lock George out of his own app by
  failing on purpose, so the wait is capped rather than being a lock that has to expire.
- The counter lives in memory. No new file, no database. A restart clears it, which is
  acceptable because only George can restart the process.
- Identity from `tailscale-user-login` and `x-forwarded-for` is used for labelling the alert
  and keying the counter, never as proof of who someone is. A process on the laptop can forge
  those headers, so a global counter sits underneath the per-device one as a backstop.

**Open questions.**

- How many failures before the wait starts, and what should the cap be? Proposal: three free
  attempts, then 2s, 4s, 8s and so on, capped at five minutes.
- Should the email also fire on a successful login from a device that had been failing, so
  George learns that whoever it was eventually got in?
