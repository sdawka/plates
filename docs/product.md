# Plates: product spec

A Slack agent you tag when you ask someone for something. It reads the conversation, works out each ask, and puts it on the right person's plate. It tracks each ask as it moves between people until it's done. Snoozed asks stay visible.

This is the spec Plates was built from, kept current through the decisions log at the end. Everything in sections 3 to 7 is built.

---

## 1. Problems → design responses

| Problem | Design response |
|---|---|
| Busy people let asks drop | Each ask is a tracked item that is **always on exactly one person's plate**. **Only the requester can end an ask** (close or withdraw it), so nothing disappears without the requester knowing. |
| Several asks in one message, and the latest one gets all the attention | The agent splits a message into **separate asks** grouped as a *request*. Every view and reminder lists all open asks in the request, oldest first. |
| Many asks only need "got it, here's what I'll do next" | **Acknowledge** (with a next step) closes acknowledgement asks with one click, and is the first button on an acknowledgement ask. |
| Busy people need to defer without things disappearing | **Snooze changes when you get reminded, not whether the item is shown.** Snoozed asks stay on the plate with their wake time and snooze count. |
| Writing up a request is friction | The agent drafts the request itself from the thread and the messages before it. |

---

## 2. Concepts

- **Ask**: one thing someone wants from someone else.
- **Request**: the set of asks created by one `@plates` tag in one thread. It has one live message in that thread.
- **Requester**: the person who wants the thing. This is **inferred from the conversation and is not necessarily the person who tagged `@plates`**. The requester is the only person who can end an ask.
- **Tagger**: whoever typed `@plates`. They can correct the extraction by replying, but **they can't confirm it** and get no requester rights, unless they are also the requester or the owner.
- **Plate**: everything currently waiting on a given person.
  - An ask is on the **owner's** plate while it's proposed or accepted.
  - It moves to the **requester's** plate when the owner marks it done, rejects it, or sends it back for clarification.
  - From there, the requester either **closes** it, which ends it, or **puts it back** on a plate.
- **Home tab**: each person's plate, and **the main place people manage their asks**. The same actions also work from Slack threads, either with buttons or by replying in plain language.

---

## 3. Core flows

### A. Capture (anyone tags the agent, anywhere)
1. Anyone types `@plates` in a thread or channel. They can add hints such as `@bob by Friday`, or just tag it with nothing else. The person who tags it doesn't have to be the requester.
2. The bot acks within Slack's 3-second limit ("👀 Reading the thread…") and queues the extraction. That placeholder is edited into the confirmation (or the failure note), so the thread never keeps a stale "Reading…" above the card.
3. Gather context:
   - In a thread: all replies from `conversations.replies`.
   - Not in a thread: the last ~30 messages or 24h of `conversations.history`, whichever is smaller, plus any threads those messages link to.
   - Resolve user IDs to names and time zones, and fetch file titles and link unfurls.
4. The LLM pulls out a list of **asks**. For each one it infers the **requester** and the **owner**, with a confidence for each. Each ask also gets:
   - a title, a short detail, and a type: `deliverable | acknowledge | decision | info`
   - a due date if one was mentioned
   - whether the owner already said "will do / later"
   - the cited source message (permalink)
   - a **size**: `2–5 min · <1 hr · few hours · few days`. Acknowledgements default to `2–5 min`.
   - an **urgency** label: `low · normal · high · urgent`. This is only a label; it doesn't change any behaviour.
   - a one-line reason for the size and urgency
5. **Confirmation** (every time). It posts one message in the thread that **names the requester and the owner it inferred**, and says so when the tagger isn't the requester:
   > 📋 **@dana** is asking **@bob** for 3 things (tagged by @tara):
   > ☐ Q3 numbers · few hours · high
   > ☐ Ack pricing change · 2–5 min · normal
   > ☐ Intro to Dana · <1 hr · low
   > Only @dana or @bob can confirm. Something off? Just reply here or use Edit.
   > [✅ Confirm] [Edit] [Dismiss]

   **Confirming**: the ✅ Confirm button, or a reaction. The button is the discoverable path; reactions keep working for people who already use them.

   **Reacting to confirm** (`reaction_added` on this message, **from the inferred requester or the inferred owner only**):
   - ✅ / 👍 / ☑️ means **yes**. The request is created, the message becomes the live request message, and the owner is notified.
   - ❌ / 👎 / ✖️ means **no**. It replies in the thread: "What's off: the people, the items, or both?" and takes the answer as a normal reply.
   - **Any other emoji**: it replies with a clarifying question that names the actual problem, e.g. "Not sure what 🤔 means. Is @dana the one asking, or is it you?". If there's no particular doubt: "✅ to confirm, ❌ to change."
   - **Replying in plain language** works as well, e.g. "yes", "no, it's from me", "drop the intro", "it's Carol not Bob". It re-extracts and updates the same message, so a new ✅ is needed.
   - Reactions from anyone else, including the tagger, are ignored. If the tagger reacts ✅, the bot replies: "Needs a ✅ from @dana or @bob."
   - The owner's ✅ only confirms who's who. The owner still accepts or rejects separately in the next step.
   - **No reaction by the next working day**: the bot reminds the requester and owner once. If it's still unconfirmed after that, the request is marked *discarded*. It stays visible as "unconfirmed" on the requester's, owner's and tagger's Home tabs, where either the requester or the owner can still confirm it. Anyone of the three can **Dismiss** a pending or discarded request instead; that is final, it leaves every Home and the thread card says so.

   When it can't tell who the requester or owner is, it asks a specific question in the confirmation instead of guessing ("Who's asking: @dana or @tara?").
6. After confirmation, the **same message is updated in place** for the rest of the request's life:
   > 📋 @dana → @bob · 3 asks
   > ☐ Q3 numbers · few hours · high · *awaiting @bob*
   > …
7. The **owner gets a DM**: who asked, the asks with size and urgency, a link to the thread, and the action buttons.

Other ways to capture: a message shortcut ("⋯ → Put on someone's plate"), `/plates @bob send the deck`, and a DM to the bot.

### B. The ask moves between owner and requester

```
                     OWNER'S PLATE                          REQUESTER'S PLATE
                                                        
 ┌─▶ [proposed] ──accept now──▶ [in progress] ──done──▶ [delivered] ──close──▶ (closed)
 │       │  └──accept later + deadline──▶ [accepted] ─done─▶ ▲        │
 │       │                                 ▲ │snooze/wake          │
 │       ├──reject (reason optional)──────────────────────▶ [rejected] ──close──▶ (closed)
 │       ├──send back: needs info─────────────────────────▶ [clarify]
 │       └──redirect──▶ [proposed on @carol's plate]           │
 │                                                             │
 └───────────── put back (note / more detail / pushback) ◀─────┘
                         (from delivered, rejected or clarify; no round limit)

   The requester can withdraw from any state ──▶ (withdrawn)
```

**Owner actions** (they never end an ask; each one moves it somewhere):
- **Start now** (accept now): status becomes *in progress*.
- **Accept for later**: the owner sets their own deadline (a date, "next week", or "no date yet").
- **Done**: optional link, file or note. **Acknowledge** (with a next step) for acknowledgements. Either way the ask moves to the requester's plate as **delivered**, and the requester gets a notification.
- **Reject**: a reason is optional, but the form asks for one ("Reason (optional, helps @dana)"). The ask moves to the requester's plate.
- **Send back: needs more info**: the owner adds a question, and the ask moves to the requester's plate.
- **Hand off** (redirect) to someone else, who gets it as proposed.
- **Set or change the deadline** at any time.
- **Snooze**.

**Requester actions** (only the inferred requester):
- **Close**: ends the ask. This is the only way an ask is completed. One click on a delivered notification ("👍 Got it").
- **Put back on the plate**: works from delivered, rejected or clarify. The requester adds a note: more detail, an answer, pushback ("it's yours because the API is yours"), or "this isn't what I needed". The ask goes back to the owner's plate as *proposed*, and the round count goes up. There's no limit on rounds.
- **Hand off** to a different owner.
- **Withdraw**: ends the ask from any state, and the owner is told.

**Each move:**
- updates the request message in the thread
- DMs the person whose plate it moved to
- shows on both people's Home tabs
- is written to the event log, so both people can see the full back-and-forth

### C. Acting by replying in the thread
The bot reads **every message** in a thread with a request, whether or not `@plates` is tagged. It turns replies from the requester and the owner into actions:
- "rejecting this, marketing owns it" → **Reject** with that reason
- "need the account ID first" → **Send back** with that question
- "here it is: link" → **Done**, with the link attached (moves to the requester as delivered)
- "I'll get to it Thursday" → **Accept later**, deadline Thu
- "thanks, perfect" (from the requester, after delivery) → **Close**
- "no, it's yours, see the spec: …" (from the requester, after a reject) → **Put back** with that note
- Ordinary chat that isn't an action → nothing happens

How it decides:
- **High confidence and only one possible ask**: it applies the action and posts a short line with **[Undo]**.
- **Otherwise**: it asks "Did you mean: Reject *Q3 numbers*?" with [Yes] [No] [Pick ask].
- Messages from anyone other than the requester, the owner or the person who tagged it are ignored for actions.

### D. Deadlines and snoozes
- **Owner deadline**: set on accept or at any time after. **Every change DMs the requester** ("@bob moved *Q3 numbers*: Thu → Mon") and updates the thread message. The change count is shown on the ask.
- **Snooze**: *in 2h / tomorrow AM / next week / after date / custom*. The ask stays on the plate, marked 💤 with its wake time.
  - The snooze count is shown to both people ("💤×2").
  - After the **3rd snooze**, the next reminder puts *Set deadline · Hand off · Reject* before *Snooze anyway*. Snoozing anyway is still counted.

### E. Home tab (the plate)
- **Needs your response**: asks proposed to you, and asks of yours that were delivered, rejected or sent back to you. Delivered asks have one-click *Close* and *Put back* buttons.
- **On your plate**: in progress → accepted with a deadline (soonest first) → accepted with no date → snoozed (greyed). Grouped by requester, and showing size, urgency, deadline, snooze count and round count.
- **Unconfirmed**: requests where you're the requester, owner or tagger that were never confirmed, with a ✅ button for the requester or owner.
- **Waiting on others**: asks you've made that are on someone else's plate, with their status, deadline and last activity.
- **Headline**: "*2 asks need your response* · 4 asks on your plate (⚠️ 1 overdue) · waiting on 3 asks from others", with open work by size underneath ("3 × few hours · 5 × <1 hr"). Section headers carry counts; *Needs your response* and *Unconfirmed* only appear when non-empty; a first-time user sees how to put something on a plate instead of empty sections. A ↻ Refresh button republishes the view.
- Every surface shows at most three buttons per ask, the rest in a ⋯ overflow menu, in the same preferred order (Home, owner DM, reminders).
- Every action from flow B is available inline. Filters: by person and by state.

### F. Reminders
- **Daily digest DM** at a time the person chooses, in their time zone: everything in *Needs your response* and *On your plate*.
- **Ask-level reminders**: on the deadline day, then the next working day, then weekly. They go to the person whose plate the ask is on. Snoozed asks aren't reminded until they wake, but they still appear in the digest and on Home.
- **Delivered asks** waiting for the requester to close them only appear in the requester's digest and Home tab. They aren't reminded about individually.
- A daily cap per person (a user setting). Reminders over the cap go into the digest.
- **Requester controls**: *Bump* (one manual reminder per ask per day), *Withdraw*.

---

## 4. Data model

```
Request   id, channel_id, thread_ts, message_ts (confirmation → live message),
          status (pending_confirmation|confirmed|discarded|dismissed),
          tagged_by_id, requester_id, owner_id,
          attribution_confidence, attribution_reason,
          confirmed_by, confirmed_via (reaction|reply|button), created_at
Ask       id, request_id, requester_id, owner_id,
          holder_id                        -- whose plate it is on right now
          title, detail, type,
          state (proposed|in_progress|accepted|snoozed|       -- owner's plate
                 delivered|rejected|clarify|                  -- requester's plate
                 closed|withdrawn),                           -- ended, by requester only
          size (2-5min|lt1h|hours|days), size_source (llm|owner),
          urgency (low|normal|high|urgent), urgency_source (llm|owner),
          estimate_reason,
          inferred_due_at, deadline_at, deadline_change_count,
          snoozed_until, snooze_count, round_count,
          source_permalink, next_step, done_link,
          created_at, accepted_at, closed_at
AskEvent  id, ask_id, actor_id, kind, from_state, to_state, note,
          via (button|home|thread_reply|reaction|dm|command), source_ts, at
UserPrefs user_id, tz, work_hours, digest_time, max_reminders_per_day (default 5)
```

`holder_id` gives the "on whose plate" rule its own column, so each Home tab section is a single indexed query.

---

## 5. Architecture (Cloudflare + Claude)

```
Slack ──events/interactions/commands──▶ Worker (slack-cloudflare-workers)
                                         │  verify signature, ack <3s
                                         ├─▶ Queue: extract   ──▶ thread → asks   (Claude Sonnet 5.5)
                                         ├─▶ Queue: intent    ──▶ reply/reaction → action (System One, typesafe/jev-1.14)
                                         ├─▶ D1  (requests, asks, events, prefs)
                                         └─▶ Durable Object per person ("PlateKeeper")
                                                - alarms: snooze wake-ups, deadlines, digest
                                                - reminder cap and working hours
                                                - republishes Home tab on any change
```

- **Extraction**: structured output. Messages are passed with stable IDs, and every ask must cite a `source_message_ts`. An ask without a valid citation is dropped.
- **Intent on thread replies**: one System One call (`POST /v1/systemone` on OpenRouter, same key) that answers typed questions with probabilities instead of LLM-written JSON with a self-reported confidence. The state is the reply (labelled untrusted), the speaker, today and the open asks. Questions: `action`, a choice among `none` and one `"<ref>:<action>"` per pair the state machine allows this speaker (built from `availableActions` / `RULES`, so the options are enumerable); `ambiguous` (yes/no: could apply to more than one ask; only asked when several asks have an allowed action); `deadline`, a choice among `none` and the next 21 local dates (only asked when `accept_later` or `set_deadline` is on offer); and, when the owner shares a file or link, one `delivers_<ref>` yes/no per open ask. We gate on the probability of the chosen option (`p_max`), not on the confidence field. Auto-apply with Undo when `action` is not `none`, `p_max >= 0.85`, `ambiguous < 0.2` and validation passes (note = the reply text, a redirect target must be an @-mention); `p_max >= 0.5` becomes a "Did you mean"; below that nothing happens. The note and redirect target come from the message in code, so no free text is generated.
- **Reactions on the confirmation**: ✅/❌ and their equivalents are matched directly, with no model. Any other emoji goes to System One (`meaning`: yes / no / unclear, from the emoji, the reactor and the confirmation summary). Yes at `p >= 0.8` confirms like ✅, no at `p >= 0.8` answers like ❌ ("What's off"), and unclear (or a failed call) keeps the Haiku clarifying question.
- **DMs to the bot**: before extraction the queue job asks System One `is_ask` (yes/no: the message asks someone to do, deliver, decide or acknowledge something). Below 0.3 nothing is extracted and the bot answers once with a short hint. It runs in the queue job, never in the HTTP handler, so the Slack ack stays fast.
- **What Claude still does**: extraction (Sonnet writes titles, details, requester/owner attribution and estimates from the thread, and corrections), and the short clarifying question for an unclear emoji (Haiku). Both need generated text; everything that is a choice among known options is System One.
- **One state machine**: buttons, Home tab, thread replies, reactions and DMs all call the same `transition(ask, action, actor)` function. It enforces who may do what. In particular, only the requester can trigger `close` or `withdraw`; the owner can never end an ask. It also updates `holder_id`, writes the AskEvent, and sends out the thread update, DM and Home refresh.
- **Slack app**: internal custom app, installed in a single workspace. Scopes: `app_mentions:read`, `chat:write`, `commands`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `files:read`, `reactions:read`. Events: `app_mention`, `message.channels/groups/im/mpim` (only processed for threads that have a request), `reaction_added` (only on confirmation messages), `app_home_opened`.

---

## 6. Constraints

1. **Rate limits**: being an internal app exempts it from the 2025 limits on non-Marketplace apps.
2. **1:1 DMs between two people**: the bot can't be tagged there or read them. The message shortcut captures the one selected message. An opt-in user token (`im:history`) is a later option for full DM context.
3. **Private channels**: the bot has to be invited. The first time it's tagged somewhere it can't read, it says so.
4. **Tone**: the thread message is neutral and factual (status, deadline, snooze count, rounds). Reminders only go privately to the person whose plate the ask is on.
5. **Data retention**: store titles, notes, permalinks and short excerpts, not full message bodies.

---

## 7. Build order (by dependency, all shipped)

**Phase 1: the loop works end to end**
- Slack app, Worker, D1, the `transition()` state machine and the event log.
- `@plates` capture → extraction (requester and owner inferred separately from the tagger, size, urgency) → confirmation message naming requester, owner and tagger.
- Confirmation by reaction (✅ / ❌ / other emoji → clarifying question) or by plain-language reply, which re-extracts the request.
- Owner DM. All flow B actions as buttons: accept now/later, done/ack (→ delivered on the requester's plate), reject, send back, redirect. Requester actions: close, put back, redirect, withdraw.
- Deadline set/change with a DM to the requester. Snooze with its count.
- Home tab: Needs your response, On your plate, Waiting on others.
- PlateKeeper DO: snooze wake-ups and the daily digest.

**Phase 2: talk instead of click**
- Turning thread replies into actions, with Undo / "Did you mean".
- Message shortcut, `/plates` command, capture by DMing the bot.
- Reminders after the deadline with a daily cap. Prompt after the 3rd snooze. Requester Bump.

**Phase 3**
- Suggesting "looks done?" when the owner shares a file or link without saying it's done.
- Opt-in user token for DM context.
- Jira/Linear sync for `deliverable` asks.

---

## 8. Decisions log
- **2026-10-18**: Internal app, single workspace.
- **2026-10-18**: The owner must accept (now / later + their own deadline) or reject.
- **2026-10-18**: Anyone can tag `@plates` anywhere. It infers requester and owner. ~~Confirms only when unclear~~ (replaced below).
- **2026-10-18**: The snooze count is tracked and shown. After the 3rd snooze, the owner is pushed toward a real deadline, redirecting or rejecting.
- **2026-10-18**: Visible request messages in threads are fine.
- **2026-10-18**: A reason is optional on reject but always asked for. Rejected or sent-back asks go to the requester's plate. Putting it back puts the ask back on the owner's plate. All of this can be done by replying in the thread.
- **2026-10-18**: Deadline changes DM the requester.
- **2026-10-18**: The Home tab is the main surface. Threads and DMs are secondary ways to do the same things.
- **2026-10-18**: Sizes are `2–5 min · <1 hr · few hours · few days`. Urgency is a label only.
- **2026-10-18**: No time estimates in planning.
- **2026-10-18**: The bot acts on any message in a request thread; no tag needed.
- **2026-10-18**: *Done* moves the ask to the requester's plate as a delivered notification. Only the requester ends an ask (close or withdraw), whatever the owner did or said. From delivered, rejected or clarify, the requester can put it back on a plate.
- **2026-10-18**: Default reminders confirmed: daily digest, then the deadline day, the next working day, then weekly.
- **2026-10-18**: No limit on back-and-forth rounds; the count is shown.
- **2026-10-18**: The requester is inferred from the context, never assumed to be the tagger, and is named in the confirmation. A confirmation is always posted, even when attribution is clear. This replaces the earlier rule of confirming only when unclear.
- **2026-10-18**: Confirmation by emoji reaction: ✅ yes, ❌ no, any other emoji → a clarifying follow-up question.

- **2026-10-18**: Only the inferred requester or the inferred owner can confirm a request. The tagger can't, unless they are one of the two.
- **2026-10-18**: Unconfirmed requests get one reminder the next working day and are then discarded. They stay visible as "unconfirmed" on Home.
- **2026-10-18**: The daily reminder cap defaults to 5 and is adjustable per person.
- **2026-10-21**: Unconfirmed requests can be dismissed by the requester, owner or tagger (Home, thread card, confirmation and nudge DMs). Dismissed is final: no asks are created and it leaves everyone's Home.

## 9. Open questions
None right now.
