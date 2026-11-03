---
name: network
description: Work with the pi-teams agent network from Claude Code. Use when delegating work to pi workers, spawning or closing them, messaging other pi agents or peer leads, or when a message headed "From: <agent> (<id>)" arrives from one of them.
---

# pi-teams network

This session is a **lead** on a pi-teams network. The `mcp__pi-teams__*` tools spawn pi workers and message them and other leads. Replies and reports arrive on their own as new turns, headed `From: <agent> (<id>)`.

## Delegating

1. `get_models` lists the models in pi's settings. Pick a worker model from its `worker` list (coding), or its `swarm` list for read-only research. Spread workers across providers unless told otherwise.
2. `spawn_teammate` starts a coding worker in a pane next to this session. `spawn_readonly_worker` starts one that can only read, grep, find and ls. Both start **idle**.
3. Give the worker its task with `send_message(recipient=<name or id>, expectReply=true)`. State the goal, the files involved, and what "done" looks like.
4. Say what you are waiting for and **end your turn**. The worker's report wakes you.

## Waiting

Never sleep, poll, or loop to wait for a reply. A reply is delivered as your next turn the moment it arrives. If you have nothing else to do, stop.

## Replying

A message marked `Reply expected: yes` needs an answer: call `send_message(recipient=<sender id>, expectReply=false)`. Use `expectReply=true` only when you need an answer back. A reply that needs none ends the exchange.

## Peers

`list_agents` shows the workers you own and the peer leads you can reach, each with an 8-character id and an Idling, Busy or Offline status. `send_message` works for any visible id. `spawn_team_lead` starts an independent pi lead in any existing folder; you cannot close it.

## Cleaning up

`close_worker` closes one worker by id or name. `close_all_workers` closes every worker you spawned. Close workers when their work is done.

## If a tool says the network is unavailable

The message names the cause. A missing CLI is installed with `npm i -g @eleqtrizit/pi-teams-cli`; a missing or outdated version file means the pi extension must be installed or upgraded (`pi install https://github.com/eleqtrizit/pi-teams`) and pi started once.
