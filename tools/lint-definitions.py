#!/usr/bin/env python3
"""
Stopgap definition linter.

Checks a directory of process definitions for: undefined roles/states, duplicate
transition ids, dangling onDeadline / link / visibility references, states
unreachable from initialState, and states with no path to a terminal state.

    python3 tools/lint-definitions.py docs/definitions

THIS IS TEMPORARY. It exists so the definitions in docs/definitions/ can be
checked before any TypeScript exists. Replace it with the Zod-based linter in
packages/protocol as soon as that package is real, and delete this file.
"""
import json, sys, glob, os

def lint(path):
    d = json.load(open(path))
    errs = []
    name = os.path.basename(path)
    states = {s["id"] for s in d["states"]}
    roles  = {r["id"] for r in d["roles"]}
    terms  = set(d["terminalStates"])
    init   = d["initialState"]

    if init not in states: errs.append(f"initialState {init} not in states")
    for t in terms:
        if t not in states: errs.append(f"terminalState {t} not in states")
    if d["hostedBy"] not in roles: errs.append(f"hostedBy {d['hostedBy']} not a role")

    # expand transitions
    edges = []   # (from, to)
    tids = set()
    for tr in d["transitions"]:
        if tr["id"] in tids: errs.append(f"duplicate transition id {tr['id']}")
        tids.add(tr["id"])
        for r in tr.get("by", []):
            if r not in roles: errs.append(f"{tr['id']}: unknown role {r}")
        froms = tr["from"]
        if froms == ["*"]:
            froms = [s for s in states if s not in terms]
        for f in froms:
            if f not in states: errs.append(f"{tr['id']}: unknown from-state {f}")
        to = tr.get("to")
        if to is not None and to not in states:
            errs.append(f"{tr['id']}: unknown to-state {to}")
        if to is None: to_l = froms          # pure data patch: self-loop
        else: to_l = [to]
        for f in froms:
            for t in to_l: edges.append((f, t))
        od = tr.get("onDeadline")
        if od and od not in {x["id"] for x in d["transitions"]}:
            errs.append(f"{tr['id']}: onDeadline references unknown transition {od}")

    for ln in d.get("links", []):
        if ln["triggers"] not in tids:
            errs.append(f"link {ln['onEvent']} triggers unknown transition {ln['triggers']}")

    for v in d.get("visibility", []):
        for r in v["roles"]:
            if r not in roles: errs.append(f"visibility {v['path']}: unknown role {r}")
        for s in v.get("whenState", []):
            if s not in states: errs.append(f"visibility {v['path']}: unknown state {s}")

    # forward reachability from initialState
    adj = {}
    for f, t in edges: adj.setdefault(f, set()).add(t)
    seen, stack = {init}, [init]
    while stack:
        cur = stack.pop()
        for nxt in adj.get(cur, ()):
            if nxt not in seen: seen.add(nxt); stack.append(nxt)
    unreachable = states - seen
    if unreachable: errs.append(f"unreachable states: {sorted(unreachable)}")

    # backward: every state must reach some terminal state
    radj = {}
    for f, t in edges: radj.setdefault(t, set()).add(f)
    good, stack = set(terms), list(terms)
    while stack:
        cur = stack.pop()
        for prv in radj.get(cur, ()):
            if prv not in good: good.add(prv); stack.append(prv)
    dead = states - good
    if dead: errs.append(f"states with no path to a terminal state: {sorted(dead)}")

    status = "PASS" if not errs else "FAIL"
    print(f"[{status}] {name}  ({len(roles)} roles, {len(states)} states, {len(d['transitions'])} transitions)")
    for e in errs: print(f"         - {e}")
    return not errs

ok = all([lint(p) for p in sorted(glob.glob(sys.argv[1] + "/*.json"))])
sys.exit(0 if ok else 1)
