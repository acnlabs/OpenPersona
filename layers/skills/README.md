# Skills Layer — Local Skill Definitions

This directory holds **local skill definitions** — reusable skill packs that any persona can reference by name in its `persona.json`.

## Structure

```
layers/skills/
  {skill-name}/
    skill.json    ← Metadata: name, description, allowedTools, triggers
    SKILL.md      ← Behavior guide for the AI agent (optional; promotes to full section)
```

## How It Works

When a persona's `persona.json` declares a skill by name:

```json
{
  "skills": [
    { "name": "weather" }
  ]
}
```

The generator resolves it through this chain:

1. **Local definition** — `layers/skills/weather/skill.json` exists → use its metadata + SKILL.md content
2. **Inline fields** — `description`, `trigger` written directly in persona.json
3. **External soft-ref** — `install` field present (e.g. `"install": "clawhub:weather"`) → skill listed in Expected Capabilities, dormant until installed
4. **Empty fallback** — skill name only, no description (agent judges usage by name alone)

For a persona that needs public X/Twitter work, declare TweetClaw as a
dormant external skill guide:

```json
{
  "skills": [
    {
      "name": "tweetclaw",
      "description": "Search tweets and replies, export followers, look up users, monitor tweets, receive webhooks, and prepare approval-gated posts or replies",
      "install": "skillssh:xquik-dev/tweetclaw"
    }
  ]
}
```

For OpenClaw tool execution, install the plugin where the persona runs:
`openclaw plugins install @xquik/tweetclaw`. Keep API keys in the host runtime
or OpenClaw plugin config. Treat visible X/Twitter actions, such as posting or
replying, as user-confirmed steps.

## Declaring a Skill

```json
{
  "name": "weather",
  "description": "Query current weather conditions and forecasts",
  "allowedTools": ["WebFetch", "Bash(curl:*)"],
  "triggers": ["weather", "forecast", "outdoor plans"]
}
```

See `schemas/skill/skill-declaration.spec.md` for the full declaration spec.

## Relationship to the 4+5+3 Architecture

Skills are the **Skill layer** — one of the four structural layers (Soul / Body / Faculty / Skill). They define *actions the agent can take*, distinct from Faculties (which define *perceptual and expressive capabilities*).

| Layer | What it provides |
|-------|-----------------|
| Soul | Identity, personality, ethical boundaries |
| Body | Physical/virtual substrate and nervous system |
| Faculty | Persistent capabilities (voice, avatar, memory) |
| **Skill** | **Actions the agent can take** |
