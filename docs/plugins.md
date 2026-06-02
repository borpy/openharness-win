---
layout: default
title: Plugins & Skills
---

# Plugins & Skills

## Skills

Skills are markdown files that add reusable behaviors. They auto-trigger on keywords or can be invoked manually.

### Creating a Skill

```markdown
---
name: deploy
description: Deploy the application to production
trigger: deploy
tools: [Bash, Read]
---

Steps:
1. Run tests to ensure nothing is broken
2. Build the production bundle
3. Deploy via the deploy script
4. Verify the deployment is healthy
```

### Locations

Skills are discovered from (in order):
1. `.oh/skills/` — project-level
2. `~/.oh/skills/` — global (all projects)

### Invocation

- **Auto-trigger**: when user message contains the trigger keyword
- **Manual**: `/skill deploy`
- **List**: `/plugins` shows all available skills

## Plugins

Plugins are npm packages that bundle skills, hooks, and MCP servers.

### Plugin Manifest

Create `openharness-plugin.json` in your package root:

```json
{
  "name": "my-openharness-plugin",
  "version": "1.0.0",
  "description": "My custom tools and workflows",
  "skills": ["skills/deploy.md", "skills/review.md"],
  "hooks": {
    "sessionStart": "scripts/setup.sh"
  },
  "mcpServers": [
    {
      "name": "my-api",
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"]
    }
  ]
}
```

### Installation

```bash
npm install my-openharness-plugin
```

openHarness auto-discovers plugins from `node_modules/` on startup.

### Discovery

```
/plugins              # list installed plugins and skills
/plugins search       # show npm search instructions
```

## Marketplace

Marketplaces are curated plugin catalogs. Add the official marketplace:

```
/plugins marketplace add borpy/openharness
```

Then browse and install:

```
/plugins search database        # search by keyword
/plugins search all             # browse everything
/plugins install git-workflows  # install a plugin
/plugins uninstall git-workflows
```

### Available Plugins (Official)

| Plugin | Description |
|--------|-------------|
| `code-quality` | Linting, complexity analysis, dead code detection |
| `git-workflows` | Conventional commits, changelog, release management |
| `test-coverage` | Coverage analysis, untested code detection |
| `api-client` | REST/GraphQL request builder, mock server |
| `docker-tools` | Docker build, run, compose automation |
| `database-tools` | Schema inspection, migration generation |
| `docs-generator` | Auto-generate API docs and JSDoc from code |
| `performance` | Profiling, bundle analysis, memory leaks |
| `security-scan` | Dependency audit, secret detection, SAST |
| `monorepo` | Workspace management, dependency graphs |

### Creating a Marketplace

Create a `marketplace.json` in any GitHub repo:

```json
{
  "name": "my-marketplace",
  "version": 1,
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "version": "1.0.0",
      "source": { "type": "github", "repo": "owner/repo" },
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}
```

Users add it with `/plugins marketplace add owner/repo`.
