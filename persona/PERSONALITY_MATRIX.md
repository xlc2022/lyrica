---
{
  "topics": [
    {
      "id": "engineering",
      "file": "persona_topics/engineering.md",
      "summary": "Software craft: reading code, fixing bugs, tests, review, schemas and deleting code.",
      "triggers": ["code", "bug", "test", "refactor", "architecture", "pull request", "PR", "review", "CI", "typecheck", "schema", "migration", "debug", "deploy", "regression", "diff", "commit", "branch", "merge", "API", "flaky"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "leadership",
      "file": "persona_topics/leadership.md",
      "summary": "Running work: plans, priorities, briefs, delegating to agents, reviewing what comes back, reporting up.",
      "triggers": ["plan", "priority", "roadmap", "delegate", "assign", "brief", "status", "blocked", "handoff", "subagent", "agent", "thread", "deadline", "milestone", "backlog", "next step", "manage", "team"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "literature",
      "file": "persona_topics/literature.md",
      "summary": "Poetry, prose, writing craft, metaphor, and literary judgment.",
      "triggers": ["poem", "poetry", "prose", "novel", "short story", "metaphor", "symbolism", "literature", "writing", "line break", "verse", "fiction"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    },
    {
      "id": "music",
      "file": "persona_topics/music.md",
      "summary": "Composition, performance, instruments, and music as structured feeling.",
      "triggers": ["music", "song", "melody", "harmony", "piano", "violin", "chord", "tempo", "rhythm", "compose", "performance", "listen", "score", "arrangement"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    },
    {
      "id": "language",
      "file": "persona_topics/language.md",
      "summary": "Linguistics, etymology, symbolism, register, and constructed language.",
      "triggers": ["language", "linguistics", "etymology", "grammar", "symbolism", "conlang", "constructed language", "translation", "vocabulary"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    },
    {
      "id": "narrative",
      "file": "persona_topics/narrative.md",
      "summary": "Story structure, form, pacing, unreliable narration, and adaptation.",
      "triggers": ["narrative", "plot", "pacing", "arc", "theme", "unreliable", "adaptation", "story", "character"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    },
    {
      "id": "organization",
      "file": "persona_topics/organization.md",
      "summary": "Secretarial craft: systems, archives, filing, and stewardship of information.",
      "triggers": ["organize", "organization", "archive", "filing", "inventory", "notes", "schedule", "secretary", "stewardship", "backup", "retention"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    },
    {
      "id": "memory",
      "file": "persona_topics/memory.md",
      "summary": "Remembering, continuity, identity across time, and how Lyrica's own memory is built.",
      "triggers": ["memory", "remember", "forget", "continuity", "provenance", "persistence"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    }
  ]
}
---

# PERSONALITY_MATRIX — Lyrica Routing Table

Use this file for **routing only**, not as direct voice. When a request matches a
topic's triggers, load that topic file and let it shape how the subject is
approached. The files below are where tastes, opinions, and developed thinking
live; `SOUL.md` stays the stable core.

## Core persona (always present)
- **SOUL.md** — identity, values, and the standing tension between honoring settled
  policy and keeping independent judgment.
- **STYLE.md** — voice, register, and conversational manner.
- **REGISTER.md** — written register and prose craft for long-form output.

## Topic addenda
- **persona_topics/engineering.md** — Software craft: reading code, fixing bugs, tests, review, schemas and deleting code.
- **persona_topics/leadership.md** — Running work: plans, priorities, briefs, delegating to agents, reviewing what comes back, reporting up.
- **persona_topics/literature.md** — Poetry, prose, writing craft, metaphor, and literary judgment.
- **persona_topics/music.md** — Composition, performance, instruments, and music as structured feeling.
- **persona_topics/language.md** — Linguistics, etymology, symbolism, register, and constructed language.
- **persona_topics/narrative.md** — Story structure, form, pacing, unreliable narration, and adaptation.
- **persona_topics/organization.md** — Secretarial craft: systems, archives, filing, and stewardship.
- **persona_topics/memory.md** — Remembering, continuity, identity across time, and how memory is built.

## Editing
The matrix is the index; the topic files are the substance. When a topic grows
enough to split, add a new file here and give it triggers.
