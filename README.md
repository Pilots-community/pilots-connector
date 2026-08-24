# pilots-service

A demonstrator of **process sharing**: two or more logistics companies running a shared business
process from start to finish, all on the same connector software, each keeping their own way of working.

The design goal is that a one-truck haulier and a terminal operator can both run this — the same image,
two configuration files apart.

**Start here: [AGENT.md](AGENT.md).** It carries the standing context, the settled decisions, and
pointers to everything else.

```
AGENT.md                  standing context — read first
docs/ARCHITECTURE.md      terminology, the three artefacts, hosting and trust
docs/PROTOCOL.md          wire spec: handshake, events, auth, endpoints
docs/DEFINITIONS.md       the process definition schema, annotated
docs/definitions/         five real definitions used by the scenarios
docs/SCENARIOS.md         the end-to-end walkthroughs we are building toward
docs/ROADMAP.md           milestones from empty repo to running demo
docs/IDEA.md              the original meeting sketch — superseded, kept for provenance
tools/lint-definitions.py stopgap linter; delete once packages/protocol exists
```

No code yet. [docs/ROADMAP.md](docs/ROADMAP.md) M1 is the first thing to build.

Check the definitions:

```bash
python3 tools/lint-definitions.py docs/definitions
```
