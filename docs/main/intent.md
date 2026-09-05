# Intent: herdr-phone

## The idea

I run coding agents on a desktop box at home. Herdr keeps them in panes and knows what each
one is doing. When I am out of the house I still want to see them, and when one stops and asks
me a question I want to answer it from my phone instead of waiting until I am back at a
keyboard.

SSH from a phone works and I have used it, but a terminal on a 6 inch screen is a bad way to
read a transcript and a worse way to type an answer. I want a real app: an icon on the iPhone
home screen that opens to a list of my agents, tells me which ones are working and which ones
are waiting on me, lets me open one, read what it said, and reply.

## What it is

One small web app that runs next to the Herdr server on the same machine and talks to it over
the local socket. Nothing is exposed to the internet. On my box it comes out over Tailscale
with `tailscale serve`, so it is reachable from my phone and from nowhere else.

It is a public MIT repo, because this is not specific to my box. Anyone running Herdr on a
Linux machine, a Mac, or a Pi should be able to clone it, start it, and get the same thing for
their own phone. That means no path, name, token or hostname of mine anywhere in the repo, and
no assumption about where Herdr keeps its socket beyond what Herdr itself already tells us.

## What I want to be able to do from the phone

- See every agent, its name, its repo, and whether it is idle, working, blocked or done. The
  ones that are blocked and waiting on me should be obvious at a glance.
- Open an agent and read the transcript, not a raw dump of escape codes.
- Type a prompt and send it.
- Press the keys I actually press: escape to interrupt, enter to accept, yes, no.
- See the raw terminal when the pretty view is not enough, colours and all.
- See the worktrees and the plugin actions, and run an action.

## What I do not want

- A second thing to keep alive. One process, no database, no build step, no npm install of
  forty packages that go stale.
- Anything that can be reached without logging in. This app can type into a Claude session
  running with permissions bypassed, so it is remote code execution with a nice UI. It needs
  a token before it does anything, even on a private tailnet.
- Silent breakage when Herdr updates. If the protocol it speaks moves on, I want the app to
  say so on startup in one clear sentence rather than half working.

## Who it is for

Me first, from my phone, at night and when I am away. Then anyone else running Herdr who wants
the same. If someone clones it and the only thing they have to do is start it, it worked.
