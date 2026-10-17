---
name: team-hillclimb
description: Run an open-ended optimization as a team of diverse-model workers that hill-climb a scored candidate in rounds, then periodically forget every session and restart from the best candidate. Use when a task has a score command and no single right answer, such as performance tuning, heuristic search, cutting cycles or runtime, or improving a benchmark number. Triggers: "team hillclimb", "hill-climb this", "optimize with a team", "autoresearch", "push this score", "forgetting team". Do not use for bug fixes or feature work; use implement-tasks for those.
---

# Team hill-climb with forgetting

This skill is based on "Scaling Discovery Requires Forgetting" (Tan et al., 2026). A single agent, parallel agents, and communicating agents all plateau. As a session grows, the agent anchors to its own past attempts and makes smaller, more conservative edits. Discarding every session and restarting all workers from the best candidate unblocks the plateau. Most of the gain comes from the first forget.

You, the lead, do all the bookkeeping by hand. Candidates and scores travel only in `send_message`. Keep the ledger in your own context and write nothing to the repo except the final result.

## Inputs

Get these from the user before you start. Ask only for what is missing.

- **Task:** what to improve and the rules a candidate must follow.
- **Target file:** the single file that a candidate replaces (for example, `src/solver.cpp`).
- **Score command:** a command that scores a candidate and prints one number. It must accept the candidate path or run inside a directory that holds the candidate. Run it once on the starting file to confirm that it works and to record the baseline score.
- **Direction:** higher is better, or lower is better.

Defaults, unless the user overrides them:

| Setting | Default |
| --- | --- |
| Workers per round (N) | 4 |
| Rounds | 4 (3 forgets) |
| Proposals per worker per round (K) | 5 |

## Model selection

Model diversity raises the chance of success. Different models propose different ideas, and the diversity lowers the homogenizing effect of peer communication.

1. Call `get_flavored_models`.
2. If the orchestrator or worker lists are not empty, then build the pool from both lists. Coding workers come from the worker list, and orchestrator models add stronger planners to the mix.
3. If both lists are empty, then call `get_models` and build the pool from the scoped models. Pick a variety across providers and model families, OSS and frontier both.
4. Assign models round-robin across workers so that no two workers in a round share a model when the pool allows it. Prefer spreading across providers.
5. In each new round, rotate the assignment so that a different model gets each slot.

Never use the swarm list. Swarm models are read-only and cannot run the score command.

## Scratch copies

Each worker works in a private scratch directory, so workers never overwrite each other:

```
$TMPDIR/team-hillclimb/<run-id>/<worker-name>/
```

The worker copies the files it needs there, edits its copy of the target file, and runs the score command against it. It never edits the target file in the repo. At each forget, delete the run's scratch directories with `rm -rf` before you respawn.

## Ledger

Keep the ledger in your context as a short table. Update it after every report.

| Round | Worker | Model | Best score | One-line idea |
| --- | --- | --- | --- | --- |

Also hold the full text of the overall best candidate and its score. Workers send the full candidate only when they beat their personal best, so you always hold the current best.

## Round loop

1. **Spawn.** Spawn N workers with `spawn_teammate`. Pass each worker its model from the model selection. Name the workers `r<round>-<letter>` (for example, `r2-a`), so names never repeat across rounds.
2. **Brief.** Send each worker the first-turn message below with `expectReply: true`. Include the best candidate inline.
3. **Collect.** Each worker scores one proposal and reports. After each report, update the ledger. Then reply to that worker with a status line and `expectReply: true`:

   ```
   Round 2, proposal 3/5. Your best: 1,145. Team best: 1,201 (r2-c: rewrote the tree read).
   Peers: r2-b 1,180 (vectorized hash), r2-c 1,201, r2-d 1,102. Continue.
   ```

   The status names the peers and their ideas in one line each. It never contains peer candidates.
4. **Stop the round.** End the round when every worker has made K proposals. End it early when most workers show plateau signals:
   - Edits get smaller and smaller.
   - Turns report no candidate.
   - A worker claims it has reached "the practical limit".
   - A worker repeats an idea that it already tried.
5. **Forget.** Follow the steps in the next section.

While workers run, stop and output "I'm waiting for workers to finish." The reports arrive as messages.

## Forget

1. Pick the best candidate from the ledger.
2. Run `close_all_workers`. Every session is discarded.
3. Delete the run's scratch directories.
4. Start the next round with fresh workers. The first-turn message contains only the task, the best candidate, and its score. It contains no ledger, no list of failed ideas, and no peer summaries from earlier rounds. The new workers must not be conditioned on earlier attempts.
5. Keep your own ledger rows for the final report, but do not pass them on.

## Peer communication

Workers are siblings, so they can message each other directly. To build on a peer's idea, a worker asks that peer for its candidate with `send_message` and `expectReply: true`. The peer answers with the candidate and `expectReply: false`.

Workers do not broadcast candidates to `all`. When every agent reads every full solution, the proposals homogenize.

## First-turn message

Send this to every worker at the start of each round. Fill in the placeholders.

```
## Team hill-climb, round <k> of <R>

# Task
<task description and rules>

# Candidate
Target file: <path>. Direction: <higher|lower> is better.
Starting candidate (score <score>):

<full candidate text>

# Scoring
Score command: <command>
Your scratch directory: $TMPDIR/team-hillclimb/<run-id>/<worker-name>/
Copy what you need there. Edit only your scratch copy. Never edit the repo.

# Peers
Your peers this round: <names>. To build on a peer's idea, ask that peer for its
candidate with send_message. Do not broadcast candidates to "all".

# Loop
1. Make one coherent change to your candidate. Bold changes are welcome; a failed
   proposal costs one turn.
2. Score it with the score command.
3. Report to the lead with send_message (expectReply: false):
   - score
   - a 2 to 3 line summary of the change
   - the full candidate, only if the score is your new personal best
4. Stop and wait. The lead sends your status and peer scores, then you continue.

Do not keep a history file. Do not stop proposing on your own; the lead ends the round.
When the lead tells you the run is over, close yourself with close_myself.
```

## Finish

After the last round:

1. Run `close_all_workers` and delete the run's scratch directory.
2. Run the score command on the best candidate yourself to confirm the score.
3. Report to the user: the best score, the baseline, the best score at the end of each round, and the models that produced the winning changes.
4. Write the best candidate to the target file only if the user asks for it.
