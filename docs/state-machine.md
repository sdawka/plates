# Ask state machine

Generated from `RULES` in `src/domain/transitions.ts` by `npm run diagram`. Do not edit by hand.

Owner's plate: proposed, in_progress, accepted, snoozed. Requester's plate: delivered, rejected, clarify. Ended: closed, withdrawn.

```mermaid
stateDiagram-v2
  [*] --> proposed: confirmed
  proposed --> in_progress: accept_now (owner)
  accepted --> in_progress: accept_now (owner)
  snoozed --> in_progress: accept_now (owner)
  proposed --> accepted: accept_later (owner)
  proposed --> delivered: done (owner)
  in_progress --> delivered: done (owner)
  accepted --> delivered: done (owner)
  snoozed --> delivered: done (owner)
  proposed --> delivered: ack (owner)
  in_progress --> delivered: ack (owner)
  accepted --> delivered: ack (owner)
  snoozed --> delivered: ack (owner)
  proposed --> rejected: reject (owner)
  in_progress --> rejected: reject (owner)
  accepted --> rejected: reject (owner)
  snoozed --> rejected: reject (owner)
  proposed --> clarify: send_back (owner)
  in_progress --> clarify: send_back (owner)
  accepted --> clarify: send_back (owner)
  snoozed --> clarify: send_back (owner)
  proposed --> snoozed: snooze (owner)
  in_progress --> snoozed: snooze (owner)
  accepted --> snoozed: snooze (owner)
  snoozed --> snoozed: snooze (owner)
  proposed --> proposed: redirect (owner)
  in_progress --> proposed: redirect (owner)
  accepted --> proposed: redirect (owner)
  snoozed --> proposed: redirect (owner)
  delivered --> proposed: redirect (requester)
  rejected --> proposed: redirect (requester)
  clarify --> proposed: redirect (requester)
  proposed --> proposed: redirect (requester)
  delivered --> closed: close (requester)
  rejected --> closed: close (requester)
  clarify --> closed: close (requester)
  delivered --> proposed: put_back (requester)
  rejected --> proposed: put_back (requester)
  clarify --> proposed: put_back (requester)
  proposed --> withdrawn: withdraw (requester)
  in_progress --> withdrawn: withdraw (requester)
  accepted --> withdrawn: withdraw (requester)
  snoozed --> withdrawn: withdraw (requester)
  delivered --> withdrawn: withdraw (requester)
  rejected --> withdrawn: withdraw (requester)
  clarify --> withdrawn: withdraw (requester)
  snoozed --> accepted: wake (back to where it was) (system)
  closed --> [*]
  withdrawn --> [*]
```

| Action | Who, from which states | Lands in |
|---|---|---|
| `accept_now` | owner: proposed, accepted, snoozed | in_progress |
| `accept_later` | owner: proposed | accepted |
| `done` | owner: proposed, in_progress, accepted, snoozed | delivered |
| `ack` | owner: proposed, in_progress, accepted, snoozed | delivered |
| `reject` | owner: proposed, in_progress, accepted, snoozed | rejected |
| `send_back` | owner: proposed, in_progress, accepted, snoozed | clarify |
| `set_deadline` | owner: accepted, in_progress, snoozed | (same state) |
| `snooze` | owner: proposed, in_progress, accepted, snoozed | snoozed |
| `set_estimate` | owner: proposed, in_progress, accepted, snoozed | (same state) |
| `redirect` | owner: proposed, in_progress, accepted, snoozed<br>requester: delivered, rejected, clarify, proposed | proposed |
| `close` | requester: delivered, rejected, clarify | closed |
| `put_back` | requester: delivered, rejected, clarify | proposed |
| `withdraw` | requester: proposed, in_progress, accepted, snoozed, delivered, rejected, clarify | withdrawn |
| `wake` | system: snoozed | state before the snooze |
