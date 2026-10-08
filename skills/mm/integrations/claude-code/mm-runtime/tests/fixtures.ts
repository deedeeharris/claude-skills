// Synthetic mm JSON documents: the same data as tests/fixtures/*.json, which the
// core contract test reads. The test kit imports only code files, so the tests read
// the documents here; the plugin gate fails when the two copies differ.
export const FIXTURES: Record<string, any> = {
  "approval-dry-run.json": {
    "schema": "mm.approval/1",
    "dry_run": true,
    "record": {
      "id": "a1",
      "task": "t",
      "task_dir": "/work/repo/.private/pm/active/t",
      "row": "#2",
      "route": "bg-it",
      "model": "sonnet",
      "worker": "bg",
      "launch": "/babysitter:yolo {prompt}",
      "prompt_path": "/work/repo/prompts/p.md",
      "prompt_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "prompt_bytes": 1234,
      "operator": "operator",
      "channel": "cc-dialog",
      "session": "00000000-0000-4000-8000-000000000001",
      "approved_at": "2026-10-03T12:00:00+00:00",
      "expires_at": "2026-10-03T12:15:00+00:00",
      "consumed_at": null,
      "consumed_by": null
    }
  },
  "approval-ok.json": {
    "schema": "mm.approval/1",
    "dry_run": false,
    "record": {
      "id": "a1",
      "task": "t",
      "task_dir": "/work/repo/.private/pm/active/t",
      "row": "#2",
      "route": "bg-it",
      "model": "sonnet",
      "worker": "bg",
      "launch": "/babysitter:yolo {prompt}",
      "prompt_path": "/work/repo/prompts/p.md",
      "prompt_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "prompt_bytes": 1234,
      "operator": "operator",
      "channel": "cc-dialog",
      "session": "00000000-0000-4000-8000-000000000001",
      "approved_at": "2026-10-03T12:00:00+00:00",
      "expires_at": "2026-10-03T12:15:00+00:00",
      "consumed_at": null,
      "consumed_by": null
    }
  },
  "changes-after.json": {
    "schema": "mm.changes/1",
    "repo_root": "/work/repo",
    "head": "1111111111111111111111111111111111111111",
    "files": {
      "src/dirty.py": [
        131,
        1759492860000000000
      ],
      "src/new.py": [
        10,
        1759492860000000000
      ]
    },
    "submodules": {},
    "changed": [
      "src/dirty.py",
      "src/new.py"
    ]
  },
  "changes-before.json": {
    "schema": "mm.changes/1",
    "repo_root": "/work/repo",
    "head": "1111111111111111111111111111111111111111",
    "files": {
      "src/dirty.py": [
        120,
        1759492800000000000
      ]
    },
    "submodules": {}
  },
  "fence-allow.json": {
    "schema": "mm.fence/1",
    "decision": "allow",
    "actor": "worker",
    "targets": [
      {
        "path": "/work/repo/src/a.py",
        "class": null
      }
    ],
    "messages": []
  },
  "fence-deny.json": {
    "schema": "mm.fence/1",
    "decision": "deny",
    "actor": "pm",
    "targets": [
      {
        "path": "/work/repo/src/a.py",
        "class": "PROD"
      }
    ],
    "messages": [
      "mm guard: PM mode cannot directly modify product code: /work/repo/src/a.py is in /work/repo, the repository of the bound task /work/repo/.private/pm/active/t. Delegate it (subagent, workflow, Codex or background session, recorded with mm.py dispatch), or leave PM mode: mm.py unbind --session 00000000-0000-4000-8000-000000000001"
    ]
  },
  "status-bound.json": {
    "schema": "mm.status/1",
    "ok": true,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/work/repo",
      "repo_root_source": "git",
      "dir_exists": true,
      "legacy": false,
      "revision": 7
    },
    "mode": "attended",
    "open_row": {
      "id": "#2",
      "item": "Build the parser",
      "state": "IMPLEMENTING",
      "status_label": "In progress"
    },
    "rows": [
      {
        "id": "#1",
        "item": "Pick the file format",
        "state": "DONE",
        "status_label": "Done",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#2",
        "item": "Build the parser",
        "state": "IMPLEMENTING",
        "status_label": "In progress",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#3",
        "item": "Choose the storage engine",
        "state": "NEEDS_DECISION",
        "status_label": "Needs decision",
        "blocked": true,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#4",
        "item": "Wrap up: insights review + move to done/",
        "state": "BACKLOG",
        "status_label": "Not started",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": true
      }
    ],
    "waiting_on_operator": [
      {
        "row": "#3",
        "kind": "decision",
        "text": "#3 needs a decision: Choose the storage engine"
      }
    ],
    "inbox": {
      "entries": 2,
      "problems": 0,
      "closed_task_files": 0
    },
    "dispatches_in_flight": [
      {
        "id": "d4",
        "at": "2026-10-03T11:30:00+00:00",
        "route": "subagent",
        "model": "sonnet",
        "row": "#2",
        "mode": "attended",
        "worker": "subagent",
        "approval_id": "a3",
        "last_verdict": "ALIVE"
      }
    ],
    "loop": {
      "mode": "off",
      "cadence": "60m",
      "routes": [
        "bg-it:sonnet"
      ],
      "noop_count": 0,
      "noop_cap": 3,
      "last_tick": {
        "at": "2026-10-03T10:00:00+00:00",
        "result": "noop"
      },
      "stopped_reason": "stopped by the operator",
      "owner_session": null
    },
    "check": {
      "status": "ok",
      "code": 0,
      "lines": [
        "check: ledger.json and the generated files agree"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": []
  },
  "status-broad.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/",
      "repo_root_source": "git",
      "dir_exists": true,
      "legacy": false,
      "revision": 7
    },
    "mode": "attended",
    "open_row": {
      "id": "#2",
      "item": "Build the parser",
      "state": "IMPLEMENTING",
      "status_label": "In progress"
    },
    "rows": [
      {
        "id": "#1",
        "item": "Pick the file format",
        "state": "DONE",
        "status_label": "Done",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#2",
        "item": "Build the parser",
        "state": "IMPLEMENTING",
        "status_label": "In progress",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#3",
        "item": "Choose the storage engine",
        "state": "NEEDS_DECISION",
        "status_label": "Needs decision",
        "blocked": true,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#4",
        "item": "Wrap up: insights review + move to done/",
        "state": "BACKLOG",
        "status_label": "Not started",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": true
      }
    ],
    "waiting_on_operator": [
      {
        "row": "#3",
        "kind": "decision",
        "text": "#3 needs a decision: Choose the storage engine"
      }
    ],
    "inbox": {
      "entries": 2,
      "problems": 0,
      "closed_task_files": 0
    },
    "dispatches_in_flight": [
      {
        "id": "d4",
        "at": "2026-10-03T11:30:00+00:00",
        "route": "subagent",
        "model": "sonnet",
        "row": "#2",
        "mode": "attended",
        "worker": "subagent",
        "approval_id": "a3",
        "last_verdict": "ALIVE"
      }
    ],
    "loop": {
      "mode": "off",
      "cadence": "60m",
      "routes": [
        "bg-it:sonnet"
      ],
      "noop_count": 0,
      "noop_cap": 3,
      "last_tick": {
        "at": "2026-10-03T10:00:00+00:00",
        "result": "noop"
      },
      "stopped_reason": "stopped by the operator",
      "owner_session": null
    },
    "check": {
      "status": "ok",
      "code": 0,
      "lines": [
        "check: ledger.json and the generated files agree"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": [
      {
        "code": "FENCE-ROOT-TOO-BROAD",
        "message": "the binding of session 00000000-0000-4000-8000-000000000001 records / as its repository root, a filesystem root or a folder holding your home folder: run mm.py unbind --session 00000000-0000-4000-8000-000000000001; bind refuses that root, so move the task into a repository or a project folder below your home folder before binding again"
      }
    ]
  },
  "status-dispatches-unreadable.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/work/repo",
      "repo_root_source": "git",
      "dir_exists": true,
      "legacy": false,
      "revision": 7
    },
    "mode": "attended",
    "open_row": {
      "id": "#2",
      "item": "Build the parser",
      "state": "IMPLEMENTING",
      "status_label": "In progress"
    },
    "rows": [
      {
        "id": "#1",
        "item": "Pick the file format",
        "state": "DONE",
        "status_label": "Done",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#2",
        "item": "Build the parser",
        "state": "IMPLEMENTING",
        "status_label": "In progress",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#3",
        "item": "Choose the storage engine",
        "state": "NEEDS_DECISION",
        "status_label": "Needs decision",
        "blocked": true,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#4",
        "item": "Wrap up: insights review + move to done/",
        "state": "BACKLOG",
        "status_label": "Not started",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": true
      }
    ],
    "waiting_on_operator": [
      {
        "row": "#3",
        "kind": "decision",
        "text": "#3 needs a decision: Choose the storage engine"
      }
    ],
    "inbox": {
      "entries": 2,
      "problems": 0,
      "closed_task_files": 0
    },
    "dispatches_in_flight": [],
    "loop": {
      "mode": "off",
      "cadence": "60m",
      "routes": [
        "bg-it:sonnet"
      ],
      "noop_count": 0,
      "noop_cap": 3,
      "last_tick": {
        "at": "2026-10-03T10:00:00+00:00",
        "result": "noop"
      },
      "stopped_reason": "stopped by the operator",
      "owner_session": null
    },
    "check": {
      "status": "ok",
      "code": 0,
      "lines": [
        "check: ledger.json and the generated files agree"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": [
      {
        "code": "DISPATCHES-UNREADABLE",
        "message": "the dispatch log /work/repo/.private/pm/active/t/prompts/dispatches.jsonl cannot be read or holds a line that is not a dispatch record (JSONDecodeError: Expecting value: line 1 column 7 (char 6)), so in-flight dispatches are unknown: inspect /work/repo/.private/pm/active/t/prompts/dispatches.jsonl, move the bad line aside, and run mm.py status again"
      }
    ]
  },
  "status-inbox-unreadable.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/work/repo",
      "repo_root_source": "git",
      "dir_exists": true,
      "legacy": false,
      "revision": 7
    },
    "mode": "attended",
    "open_row": {
      "id": "#2",
      "item": "Build the parser",
      "state": "IMPLEMENTING",
      "status_label": "In progress"
    },
    "rows": [
      {
        "id": "#1",
        "item": "Pick the file format",
        "state": "DONE",
        "status_label": "Done",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#2",
        "item": "Build the parser",
        "state": "IMPLEMENTING",
        "status_label": "In progress",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#3",
        "item": "Choose the storage engine",
        "state": "NEEDS_DECISION",
        "status_label": "Needs decision",
        "blocked": true,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#4",
        "item": "Wrap up: insights review + move to done/",
        "state": "BACKLOG",
        "status_label": "Not started",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": true
      }
    ],
    "waiting_on_operator": [
      {
        "row": "#3",
        "kind": "decision",
        "text": "#3 needs a decision: Choose the storage engine"
      }
    ],
    "inbox": null,
    "dispatches_in_flight": [
      {
        "id": "d4",
        "at": "2026-10-03T11:30:00+00:00",
        "route": "subagent",
        "model": "sonnet",
        "row": "#2",
        "mode": "attended",
        "worker": "subagent",
        "approval_id": "a3",
        "last_verdict": "ALIVE"
      }
    ],
    "loop": {
      "mode": "off",
      "cadence": "60m",
      "routes": [
        "bg-it:sonnet"
      ],
      "noop_count": 0,
      "noop_cap": 3,
      "last_tick": {
        "at": "2026-10-03T10:00:00+00:00",
        "result": "noop"
      },
      "stopped_reason": "stopped by the operator",
      "owner_session": null
    },
    "check": {
      "status": "ok",
      "code": 0,
      "lines": [
        "check: ledger.json and the generated files agree"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": [
      {
        "code": "INBOX-UNREADABLE",
        "message": "the inbox of /work/repo/.private/pm/active/t cannot be scanned ([Errno 13] Permission denied: '/work/repo/.private/pm/active/t/inbox/20261003-120000-worker.md'), so worker reports may be missed: run mm.py inbox-scan --task-dir /work/repo/.private/pm/active/t to see which file, fix or move it aside, and run mm.py status again"
      }
    ]
  },
  "status-ledger-invalid.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/work/repo",
      "repo_root_source": "git",
      "dir_exists": true,
      "legacy": false,
      "revision": null
    },
    "mode": null,
    "open_row": null,
    "rows": [],
    "waiting_on_operator": [],
    "inbox": {
      "entries": 0,
      "problems": 0,
      "closed_task_files": 0
    },
    "dispatches_in_flight": [],
    "loop": null,
    "check": {
      "status": "failed",
      "code": 1,
      "lines": [
        "FAIL ledger.json: rows[0].state 'DOING' is not a known state"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": [
      {
        "code": "LEDGER-INVALID",
        "message": "ledger.json of /work/repo/.private/pm/active/t does not validate: run mm.py check --task-dir /work/repo/.private/pm/active/t and repair what it reports with mm.py commands"
      }
    ]
  },
  "status-legacy.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "legacy-default",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": null,
      "repo_root_source": null,
      "dir_exists": true,
      "legacy": false,
      "revision": 7
    },
    "mode": "attended",
    "open_row": {
      "id": "#2",
      "item": "Build the parser",
      "state": "IMPLEMENTING",
      "status_label": "In progress"
    },
    "rows": [
      {
        "id": "#1",
        "item": "Pick the file format",
        "state": "DONE",
        "status_label": "Done",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#2",
        "item": "Build the parser",
        "state": "IMPLEMENTING",
        "status_label": "In progress",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#3",
        "item": "Choose the storage engine",
        "state": "NEEDS_DECISION",
        "status_label": "Needs decision",
        "blocked": true,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": false
      },
      {
        "id": "#4",
        "item": "Wrap up: insights review + move to done/",
        "state": "BACKLOG",
        "status_label": "Not started",
        "blocked": false,
        "user_facing": false,
        "test_level": "unit",
        "pr": null,
        "test_page": null,
        "is_wrapup": true
      }
    ],
    "waiting_on_operator": [
      {
        "row": "#3",
        "kind": "decision",
        "text": "#3 needs a decision: Choose the storage engine"
      }
    ],
    "inbox": {
      "entries": 2,
      "problems": 0,
      "closed_task_files": 0
    },
    "dispatches_in_flight": [
      {
        "id": "d4",
        "at": "2026-10-03T11:30:00+00:00",
        "route": "subagent",
        "model": "sonnet",
        "row": "#2",
        "mode": "attended",
        "worker": "subagent",
        "approval_id": "a3",
        "last_verdict": "ALIVE"
      }
    ],
    "loop": {
      "mode": "off",
      "cadence": "60m",
      "routes": [
        "bg-it:sonnet"
      ],
      "noop_count": 0,
      "noop_cap": 3,
      "last_tick": {
        "at": "2026-10-03T10:00:00+00:00",
        "result": "noop"
      },
      "stopped_reason": "stopped by the operator",
      "owner_session": null
    },
    "check": {
      "status": "ok",
      "code": 0,
      "lines": [
        "check: ledger.json and the generated files agree"
      ]
    },
    "uncommitted": [
      " M .private/pm/active/t/HANDOFF.md"
    ],
    "errors": [
      {
        "code": "BINDING-LEGACY",
        "message": "the binding of session 00000000-0000-4000-8000-000000000001 predates r26 and records no repository root, so PM writes outside the PM folder are refused: run mm.py bind --task-dir /work/repo/.private/pm/active/t --session 00000000-0000-4000-8000-000000000001 once to record the repository root"
      }
    ]
  },
  "status-stale.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "ok",
      "bound": true,
      "role": "pm",
      "role_source": "binding",
      "bound_at": "2026-10-03T11:00:00+00:00"
    },
    "task_source": "session",
    "task": {
      "name": "t",
      "dir": "/work/repo/.private/pm/active/t",
      "repo_root": "/work/repo",
      "repo_root_source": "git",
      "dir_exists": false,
      "legacy": false,
      "revision": null
    },
    "mode": null,
    "open_row": null,
    "rows": [],
    "waiting_on_operator": [],
    "inbox": null,
    "dispatches_in_flight": [],
    "loop": null,
    "check": {
      "status": "not_run",
      "code": null,
      "lines": []
    },
    "uncommitted": null,
    "errors": [
      {
        "code": "TASK-DIR-MISSING",
        "message": "the bound task folder does not exist: the task folder /work/repo/.private/pm/active/t was moved or closed: run mm.py unbind --session 00000000-0000-4000-8000-000000000001, then bind the task where it now lives"
      }
    ]
  },
  "status-unbound.json": {
    "schema": "mm.status/1",
    "ok": true,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "absent",
      "bound": false,
      "role": null,
      "role_source": null,
      "bound_at": null
    },
    "task_source": "none",
    "task": null,
    "mode": null,
    "open_row": null,
    "rows": [],
    "waiting_on_operator": [],
    "inbox": null,
    "dispatches_in_flight": [],
    "loop": null,
    "check": {
      "status": "not_run",
      "code": null,
      "lines": []
    },
    "uncommitted": null,
    "errors": []
  },
  "status-unreadable.json": {
    "schema": "mm.status/1",
    "ok": false,
    "generated_at": "2026-10-03T12:00:00+00:00",
    "mm_version": "2.0.0",
    "session": {
      "id": "00000000-0000-4000-8000-000000000001",
      "binding_state": "unreadable",
      "bound": true,
      "role": "pm",
      "role_source": "fail-closed",
      "bound_at": null
    },
    "task_source": "session",
    "task": null,
    "mode": null,
    "open_row": null,
    "rows": [],
    "waiting_on_operator": [],
    "inbox": null,
    "dispatches_in_flight": [],
    "loop": null,
    "check": {
      "status": "not_run",
      "code": null,
      "lines": []
    },
    "uncommitted": null,
    "errors": [
      {
        "code": "BINDING-UNREADABLE",
        "message": "the session binding for 00000000-0000-4000-8000-000000000001 cannot be read (it is not valid JSON): run mm.py unbind --session 00000000-0000-4000-8000-000000000001, then mm.py bind --task-dir <task> --session 00000000-0000-4000-8000-000000000001"
      }
    ]
  }
}
