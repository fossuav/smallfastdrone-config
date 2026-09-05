# Bench session records

Point-in-time records of what a real flight controller did on a particular day.

**These are snapshots and are never revised.** Everywhere else in `docs/` the rule is
that a document reflects current intent, so a reader sees the live model rather than a
stale one. These are the exception, and the exception is the point: a bench log is
evidence, and evidence you edit afterwards is not evidence. When something here stops
being true, the correct response is a new session record and a change to the living
docs -- not an edit here.

Each record marks every result with how it was established: observed on the board,
proven offline against a reference implementation, or not proven with the reason it
could not be. That distinction is what the records are for.

| Record | Board | What it covers |
|---|---|---|
| [2026-09-05-lucid-h7.html](2026-09-05-lucid-h7.html) | TBS_LUCID_H7 | Stock ArduPilot to signed SFD firmware, secure bootloader, per-drone identity, sealing, and the exit ceremony back to stock. Eight defects found. |
