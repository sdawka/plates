# Walkthrough in Slack

A scripted tour that exercises every path. Use two or three people (call them Dana, Bob and Tara) in a test channel. Everything below should also show on each person's **Home** tab.

1. **Invite**: `/invite @plates` in the test channel. Plates posts a one-line hello.
2. **Tag**: Dana writes "@Bob can you send the Q3 numbers by Friday, and review the deck?". Tara replies in the thread with "@plates". Expect "👀 Reading the thread…", which turns into a confirmation naming Dana → Bob, tagged by Tara, with two items and a **✅ Confirm** button.
3. **Confirm rules**: Tara presses Confirm (or reacts ✅) and is told only Dana or Bob can. Bob reacts 🤔 and gets a clarifying question. Bob presses **✅ Confirm** (or reacts ✅): the request is confirmed and Bob gets a DM with *Start now · Accept for later · Reject* and a ⋯ menu for the rest.
4. **Correct**: on a fresh tag, reply "@plates it's Carol not Bob" or just "it's Carol". The same confirmation updates; no second one appears.
5. **Owner actions**: Bob accepts one item for later with a deadline (Dana gets a DM), changes the deadline (Dana gets "Thu → Mon"), snoozes the other three times (the count shows 💤×3, then the deadline / hand off / reject prompt). A past deadline shows ⚠️ overdue on Home and in the digest.
6. **Replies in the thread**: Bob writes "on it": applied with an Undo button, and Undo restores it. Bob writes something ambiguous: "Did you mean …?" with Yes / No / Pick.
7. **Done and close**: Bob marks done with a link. The item lands on Dana's plate as delivered; Dana puts it back, Bob re-delivers, Dana closes.
8. **Reject and send back**: Bob rejects with a reason; it lands on Dana's plate; Dana puts it back.
9. **Other ways in**: `/plates @Bob send the deck by Friday`; the message shortcut **Put on someone's plate** on any message; a DM to the bot.
10. **Unconfirmed**: leave a confirmation unanswered. Expect a nudge the next working day, then "unconfirmed" on Home. **Dismiss** (on Home, the thread card or the nudge DM) drops it for everyone; requester, owner or tagger can dismiss.
11. **Reminders**: `/plates settings` sets your timezone, working hours and reminder cap; the daily digest arrives at your work start.
12. **Ask Plates**: open Plates from the sidebar (or Slack's top bar, since it is an agent). The first time, it introduces itself. Try the starter prompts: "What's on my plate?", "What am I waiting on?", "How does Plates work?". `@plates help` in a channel and `/plates help` show the help privately, and **❓ How it works** on Home opens it too.
13. **Optional**: Connect DMs from Home (needs the OAuth secrets), then tag @plates in a DM the bot is not in. With `TRACKER` set, accepted deliverables appear in Jira or Linear.

Check once on real Cloudflare: two people confirming the same request at the same moment produces one set of items. The guard relies on `changes()` inside a D1 batch, which the tests only exercise on SQLite.
