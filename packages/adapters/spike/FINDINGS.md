# T13 — busy→idle detection de-risk spike (§5.2)

**Throwaway.** Not part of the baseline. Run: `bun packages/adapters/spike/detect-spike.ts`
(requires tmux + bun). Outcome below informs the dispatcher (T16), not shipped code.

## What was confirmed (real tmux + dummy agent)

```
✔ initial: output prompt present; native {"status":"idle","turn":"init"}
✔ output: prompt disappeared → busy (front idle→busy)
✔ output: prompt reappeared → idle (front busy→idle)
✔ native: idle at new turn token {"status":"idle","turn":"turn-1"} (edge, not stale init)
✔ native: turn token advanced to {"status":"idle","turn":"turn-2"} — edge-triggered
SPIKE PASSED — both §5.2 detect paths confirmed against real tmux.
```

- **Output-fallback is a front, not a level.** After injection the ready prompt
  must first **disappear** (idle→busy) and only a subsequent **reappearance** counts
  as busy→idle. Matching the prompt at the END of the captured pane (`/…>\s*$/`)
  distinguishes idle (prompt is the last thing) from busy (work is the last thing).
- **Native is edge by turn token.** A stale `idle` (`turn:"init"`, or a previous
  turn) must be ignored; only `status==idle && turn==<current token>` is busy→idle.
  The token advanced init → turn-1 → turn-2, so level-reading would have falsely
  accepted the stale idle.

## Contract notes for the dispatcher (T16)

The §8.3 `Adapter.detect` contract as implemented in T12 is **sufficient — no changes
needed**. The dispatcher owns all per-session detection state:

1. **Before injection**, fix the current turn token (the injected message `id` or a
   monotonic nonce) and clear the output front-flag (`sawBusy = false`).
2. **Inject**, then poll:
   - *native*: read `adapter.detect.statusFile(session)`; accept idle iff
     `status==idle && turn==token`. (`statusFile` is the shared convention path —
     same for hook writer and dispatcher reader; confirmed deterministic in T12.)
   - *output*: capture pane; set `sawBusy` once `readyPrompt` no longer matches the
     tail; accept idle only once `sawBusy && readyPrompt matches the tail` again.
3. The down-probe (T17) runs `tmux has-session` independently of `detect.kind` —
   confirmed necessary: on a native path the status file simply goes silent on kill,
   so only the probe surfaces busy→down.

## Caveats (already in spec)

- Output front-detection needs the poll interval **shorter** than the agent's turn
  (NFR-10); a turn faster than one cycle can skip the busy front (§5.2 boundary,
  OOS-7). Native is immune (edge by token).
- Attach-only + native requires the hook to be pre-installed writing to exactly the
  convention path (§5.2 precondition).
