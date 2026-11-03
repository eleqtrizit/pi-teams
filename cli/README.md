# @eleqtrizit/pi-teams-cli

Command-line access to the [pi-teams](https://github.com/eleqtrizit/pi-teams) agent network, for clients that are not pi, such as the Claude Code mod in this repository.

```bash
npm i -g @eleqtrizit/pi-teams-cli
pi-teams help
```

The CLI needs the pi extension, installed separately:

```bash
pi install https://github.com/eleqtrizit/pi-teams
```

Start pi once after installing or upgrading the extension. It records its version in `~/.pi/agent/pi-teams/version.txt`, and the CLI refuses to run when that file is missing or names a newer version than the CLI.

See the pi-teams README for the commands.
