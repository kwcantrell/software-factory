# Commercial and Hosted Alternatives to Warp Factories for Agentic SDLC Pipelines (as of Nov 12, 2026)

Scope note: I used about 20 tool calls (searches and fetches). Primary sources were fetched for Devin Automations (docs.devin.ai), Claude Code scheduled tasks (code.claude.com), Cursor pricing (cursor.com/pricing), and GitHub Agentic Workflows GA (InfoQ, quoting GitHub). Many other figures, especially pricing, come from third-party review or aggregator sites that often disagree with each other. Those are flagged as such. Warp is covered only for brief comparison.

## Q1: What does each product offer? (triggers, triage, org admin, observability, extensibility, pricing)

### Takeaway
By late 2026 every major vendor can start a cloud agent from an issue tracker (Linear, Jira, GitHub), Slack, a schedule or a webhook. The products differ mainly in three ways: how general their event or automation layer is (Devin Automations and GitHub Agentic Workflows are the most general), how much org-level governance they have (Cursor Enterprise, Factory Enterprise, GitHub), and whether they measure themselves (Factory "Signals" is the only product found that markets agent self-improvement). None of them ships a complete "intake, then group or dedupe, then rank, then decide, then build, then measure, then improve" loop out of the box. The pieces exist across vendors.

### Comparison table

| Product | Triggers / intake | Triage / prioritization | Multi-team / org admin | Observability / metrics | Extensibility | Pricing (sourcing caveats in findings) |
|---|---|---|---|---|---|---|
| **Factory.ai (Droids)** | CLI, IDE, Slack, web; Linear and Jira assignment; native GitHub, GitLab, Jira, Linear, Sentry and PagerDuty integrations; cloud "Droid Computers" | Pulls ticket context. No backlog ranking found. "Remote Delegations" via Slack, Linear and Jira reportedly in private preview | Teams: SSO, SAML/SCIM, ZDR, admin controls. Enterprise: audit logs, on-prem, dedicated compute | "Signals" (agent self-improvement), "Agent Readiness" codebase scoring (8 pillars). Audit logs | Model-agnostic (Claude, GPT, Gemini) | Pro $20, Plus $100, Max $200 per month. Teams quoted as custom or "$60 + $40/seat" (sources conflict). Usage-based capacity, limits not disclosed |
| **Devin (Cognition)** | Automations: Slack, MS Teams, GitHub (issues, PRs, check runs, push), GitLab (incl. pipeline), Linear (created, label, status, **priority changed**, assigned), Jira, Pylon, PagerDuty, schedule (RRULE), authenticated webhook | **"Triage Devin (monitor)"**: a persistent agent watches a Slack channel, decides what needs attention, and spawns child sessions. Devin Oncall handles alerts and incidents. Preflight LLM or script filters can skip events or emit multiple work items | Per-automation network policy, ACU caps, rate limits, queueing. Admin opt-in for public repos. Linear team scoping | Email notifications on run success or failure. **No analytics dashboard confirmed (gap)** | Skills (replacing playbooks), MCP connections (Sentry, Datadog), API, about 25 automation templates, NL-generated automations, child sessions | Sources conflict: Free / Pro $20 / Max $200 / Teams $80 + $40/seat vs. older Core $20 + $2.25/ACU, Team $500 |
| **GitHub (Copilot coding agent, Agent HQ, Agentic Workflows)** | Assign an issue to Copilot. Agentic Workflows = Markdown + YAML compiled to Actions, so any Actions event or schedule | Triage workflows label issues by type and priority. "Issue Monster" example hands triaged issues to Copilot coding agent every 40 minutes | Reuses Actions runner groups and policies, Environment reviewer gates, org-overridable budgets. Agent HQ "mission control" across agents | `gh aw forecast` cost estimates, threat-detection job. Little else documented | Engines: Copilot CLI, Claude Code, Codex. Third-party agents in Agent HQ (Anthropic, OpenAI, Google, Cognition, xAI) | gh-aw on Free, Team and Enterprise. AI Credits at $0.01. Default cap 1,000 AIC (~$10) per run and 5,000 per day. Copilot license for default engine. Premium requests $0.04 overage |
| **Cursor (Cloud Agents, Automations, Bugbot)** | Desktop, web, iOS, Slack, GitHub or Bitbucket comment, Linear, API. Automations on cron, PR, push, Slack message | None native found (relies on Linear) | Teams: central billing, SSO, usage analytics. Enterprise: SCIM, group spend limits, repo/model/MCP access controls, audit logs, service accounts | Team usage analytics | Team rules, skills, marketplace, MCP | Cloud agents on Premium $30+/mo. Teams $30+/user. Enterprise custom. Agent runs billed at model API rates (third-party sources quote older Teams $40) |
| **OpenAI Codex cloud** | Assign or @Codex in Linear, @Codex in GitHub PRs, automatic PR review, Slack | None native found | Enterprise admin enables cloud chats and Linear connector in workspace settings | Not found | Cloud features not available via API key | Bundled in ChatGPT: Plus $20, Pro from $100, Business ~$20–25/user, Enterprise custom |
| **Claude Code (Anthropic)** | Cloud scheduled tasks (formerly "routines"): schedule, API `/fire`, GitHub events (PR, release). `claude-code-action` in GitHub Actions on mention or assignment. Claude Code on the web. Managed Agents (API-hosted) | None native. Triage is a common use case people build themselves | Owners toggle scheduled tasks org-wide, custom roles, org-shared cloud environments, network allowlists, self-hosted environments. **Tasks belong to individual accounts, not shared with teammates** | Usage page only | Connectors (MCP), Agent SDK, skills, Managed Agents for building your own | Included in Pro, Max, Ultra, Team, Enterprise usage. Hourly run caps. Metered overage with usage credits. Actions billed at API rates |
| **Google Jules** | Web, GitHub. Scheduled tasks, suggested tasks, automatic CI fixes. Alpha REST API | "Suggested tasks" (proactive). No ranking | Not found | Not found | v1alpha API | Free 15 tasks/day. AI Pro $19.99 (100/day). Ultra 300/day (price conflicting, $99.99–$249.99) |
| **Linear (for agents and Triage Intelligence)** | Agents (Cursor, Codex, Devin, Codegen, Sentry, etc.) take assigned issues like teammates | **Triage Intelligence** suggests team, project, assignee, labels, **duplicates and related issues**. Per-property auto-apply. Triage rules can auto-delegate to agents (Business+) | Workspace, team and sub-team guidance and settings inheritance | Not found | Agent API for third parties | Triage Intelligence on Business ($16/user/mo, yearly) and Enterprise. Basic Linear Agent chat on all plans |
| **Amp (spun out of Sourcegraph)** | CLI, cloud threads in sandboxes, "Orbs" for remote execution | None found | Shareable threads, Enterprise custom | Not found | Not detailed | Free tier, Individual from ~$20, no per-seat team charge, pay-as-you-go (sources inconsistent) |

### Cited Findings

**Factory.ai**
- Droids run from CLI, IDE, Slack and web, with native GitHub, GitLab, Jira, Linear, Sentry and PagerDuty integrations. They are model-agnostic (Claude, GPT-5, Gemini) — [Ry Walker research](https://rywalker.com/research/factory-ai)
- "Droid Computers" are Factory-managed cloud machines for background Droids, on Plus and above. "Signals" is a self-improvement system for agents. The "Agent Readiness" framework scores codebase support for autonomous work across eight pillars — [Ry Walker research](https://rywalker.com/research/factory-ai)
- Teams tier (up to 150 seats): SSO, SAML/SCIM, ZDR, admin controls. Enterprise: audit logs, on-prem, dedicated compute, SLAs — [Ry Walker research](https://rywalker.com/research/factory-ai)
- Pricing as of June 2026: Pro $20, Plus $100 (~5x), Max $200 (~10x). Token limits not disclosed. Premium models consume capacity faster — [Ry Walker research](https://rywalker.com/research/factory-ai). Teams is listed as "$60 + $40/seat" by some aggregators — [CostKite](https://costkite.com/tools/factory-droids), [Fritz.ai](https://fritz.ai/factory-ai-review/). This conflicts with "custom" pricing.
- Linear and Jira assignment starts Droids, which pull description, acceptance criteria, comments and linked context. "Remote Delegations" (shared Slack, Linear and Jira delegation) is reportedly in private preview — [aggregator search results, e.g. ToolMango](https://toolmango.com/tools/factory), [theaiagentindex](https://theaiagentindex.com/agents/factory-ai)
- Funding: $150M Series C at $1.5B (April 2026). Customers include Nvidia, Adobe, EY, Palo Alto Networks, Adyen — [Ry Walker research](https://rywalker.com/research/factory-ai)
- Factory's own 2026 writeup argues that planning, triage, validation and deployment remain human-driven bottlenecks even after coding tools improved — [ZenML LLMOps DB summary](https://www.zenml.io/llmops-database/building-autonomous-software-factories-with-ai-agents)

**Devin (Cognition)**
- Automations triggers cover Slack, MS Teams, GitHub, GitLab, Linear, Jira, Pylon, PagerDuty, schedule and webhook. GitHub triggers include issue, PR, check run (CI) and push. GitLab includes pipeline. Linear includes issue created, label added, status changed, **priority changed**, assigned and moved. Multiple triggers are OR'ed — [Devin Docs: Automations](https://docs.devin.ai/product-guides/automations)
- Actions: start a session, message a long-running session, "Triage Devin (monitor)", email notification. Triage Devin is a persistent Devin that watches a Slack channel, decides what needs attention, and spawns child sub-Devins — [Devin Docs: Automations](https://docs.devin.ai/product-guides/automations)
- Preflight check: an optional LLM filter, or a Python, Node or Bash script that can skip events, keep state (64 KiB) and emit multiple work items (default 10, max 50). Other controls: per-session ACU limits, rate limits (default 50 runs/hr, 150 for Slack triage), queue caps (overflow events are dropped), network policy. About 25 templates across monitoring, CI/CD, security and PM. Automations can also be generated from natural language — [Devin Docs: Automations](https://docs.devin.ai/product-guides/automations)
- Linear: admins can limit which Linear teams Devin accesses. Playbook labels expose playbooks from Linear. Sessions started by Linear automations can start child sessions — [Devin Docs: Linear](https://docs.devin.ai/integrations/linear). Jira: assign to the Devin service account — [Devin Docs: Jira](https://docs.devinenterprise.com/integrations/jira)
- Playbooks are being replaced by "skills". Scheduled sessions support jobs such as nightly test runs, with a "Run now" button — [Devin release notes](https://docs.devin.ai/release-notes/overview), [Using Playbooks](https://docs.devin.ai/product-guides/using-playbooks)
- Pricing conflicts. One source lists Free / Pro $20 / Max $200 / Teams $80 base + $40/seat — [Automation Atlas](https://automationatlas.io/answers/devin-pricing-explained-2026/). Another describes Core $20 + ~$2.25/ACU and Team $500/mo with 250 ACUs (1 ACU ≈ 15 min of work) — [vp0](https://vp0.com/blogs/devin-ai-pricing-plans-2026). Large or ambiguous tasks can run 5–10+ ACUs and may not yield a mergeable PR — [usecarly](https://www.usecarly.com/blog/devin-pricing/)

**GitHub**
- GitHub Agentic Workflows: technical preview Feb 13, 2026 — [GitHub Changelog](https://github.blog/changelog/2026-02-13-github-agentic-workflows-are-now-in-technical-preview/). Public preview June 2026. **GA announced Oct 28, 2026** (reported Nov 11, 2026) — [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)
- Workflows are Markdown + YAML frontmatter compiled to standard Actions. Engines: Copilot CLI (needs a Copilot license), Claude Code or Codex. They run in a sandboxed container behind a firewall, read-only by default, with "safe outputs" for writes and a threat-detection job — [GitHub Docs](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows), [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)
- Budget defaults: 1,000 AI Credits (~$10) per run, 5,000 AIC per day, 20-min agent step timeout, all org-overridable. AI Credits cost $0.01. `gh aw forecast` estimates monthly spend. Available on Free, Team and Enterprise — [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)
- Triage workflows label incoming issues by type and priority. The "Issue Monster" scheduled workflow wakes every 40 minutes to hand triaged issues to the Copilot coding agent — [GitHub Blog](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/), [gh-aw blog](https://github.github.com/gh-aw/blog/2026-09-03-agent-of-the-day/)
- Agent HQ (announced Oct 2025) is a "mission control" for assigning, steering and tracking multiple agents across GitHub, Copilot CLI, VS Code and mobile. Third-party agents come from Anthropic, OpenAI, Google, Cognition and xAI — [GitHub Blog](https://github.blog/news-insights/product-news/welcome-home-agents/), [SD Times](https://sdtimes.com/ai/github-unveils-agent-hq-the-next-evolution-of-its-platform-that-focuses-on-agent-based-development/). Sources conflict on whether third-party agents cost extra or consume premium requests — [Directions on Microsoft](https://www.directionsonmicrosoft.com/reports/github-agent-hq-brings-agent-governance-third-party-support/)
- Premium requests: Business 300/user, Enterprise 1,000/user, Pro+ 1,500. Overage $0.04 each. ITPro reported a coding-agent interaction effectively counted as ~50 premium requests at rollout (may be outdated) — [ITPro](https://www.itpro.com/software/development/github-copilot-pricing-changes-premium-requests)
- GitLab Duo Agent Platform requires human-initiated triggers, which prevents one flow from starting another — [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)

**Cursor**
- Background agents are renamed "Cloud Agents". They run in isolated VMs and can be started from desktop, web, iOS, Slack, GitHub or Bitbucket comments, Linear and the API. Automations run on cron, PR, push or Slack message — [Simular guide](https://www.simular.ai/articles/cursor-background-agents), [theaiagentindex](https://theaiagentindex.com/agents/cursor-background-agent)
- Official pricing: Free, Plus $8 (no cloud agents), Premium $30, Super $100, Ultra $200 (cloud agents, automations and Bugbot from Premium up), Teams $30+/user, Enterprise custom — [Cursor Pricing](https://cursor.com/pricing)
- Teams: centralized billing and admin, usage analytics, SAML/OIDC SSO, team marketplace. Enterprise: SCIM, granular spend controls, group-level settings and spend limits, auto-run/network controls, repo/model/MCP access controls, audit logs, service accounts — [Cursor Pricing](https://cursor.com/pricing)
- Cloud Agents are billed at the selected model's API rates against included usage, then on-demand — [sinatra.dev](https://www.sinatra.dev/blog/cursor-cloud-agents-explained)

**OpenAI Codex**
- In Linear, assigning an issue to Codex or mentioning @Codex creates a cloud task that replies with progress. Available on paid plans. Enterprise admins enable it in workspace and connector settings — [OpenAI Codex docs: Linear](https://developers.openai.com/codex/integrations/linear)
- Pricing is bundled with ChatGPT (Plus $20, Pro from $100). GitHub code review and automatic PR review are on Plus, Pro, Business and Enterprise, and not available with an API key — [OpenAI Codex Pricing](https://developers.openai.com/codex/pricing.md), [eesel](https://www.eesel.ai/blog/openai-codex-pricing)
- OpenAI published "Symphony", an open spec plus Elixir reference implementation that makes the issue tracker the agent control plane — [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)

**Claude Code (Anthropic)**
- Cloud scheduled tasks (formerly routines, research preview) are saved prompt + repos + connectors. Triggers are schedule, API (`/fire` endpoint, beta header), and GitHub events. They run on Anthropic cloud or an org's self-hosted environment. Plans: Pro, Max, Ultra, Team, Enterprise — [Claude Code Docs](https://code.claude.com/docs/en/routines)
- Limits: 100 scheduled runs per hour per account. 30 per hour per task for Run now and API fires. GitHub webhook events beyond hourly caps are dropped. Runs draw on subscription usage, with metered overage if usage credits are on — [Claude Code Docs](https://code.claude.com/docs/en/routines)
- Org admin: Owners can disable tasks org-wide, gate them through custom roles, and manage org-shared environments and network allowlists. But tasks **belong to an individual account and are not shared with teammates**. Their actions appear as that user's GitHub, Slack and Linear identity — [Claude Code Docs](https://code.claude.com/docs/en/routines)
- `anthropics/claude-code-action` runs in GitHub Actions (on mention or assignment), billed at API rates — [Gautam Khorana](https://gautamkhorana.com/blog/claude-code-routines-vs-github-actions-cron/), [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)
- Managed Agents are API-hosted sessions aimed at building products. They allow longer max duration (~24h vs ~2h for routines) and bill differently (one source cites $0.08/runtime-hour, unverified) — [developersdigest](https://www.developersdigest.tech/blog/claude-code-routines-vs-managed-agents-schedules), [aimagicx](https://www.aimagicx.com/blog/claude-code-routines-scheduled-automation-2026)

**Google Jules**
- No standalone price. Free tier: 15 tasks/24h, 3 concurrent. AI Pro ($19.99): 100/day, 15 concurrent. Ultra: 300/day, 60 concurrent. Ultra price conflicts across sources. Users can't buy extra tasks — [morphllm](https://www.morphllm.com/comparisons/jules-google-coding-agent), [agentcode](https://agentcode.ai/google-jules-pricing)
- Proactive features: suggested tasks, scheduled tasks, automatic CI fixes. Alpha REST API at jules.googleapis.com/v1alpha — [theaiagentindex](https://theaiagentindex.com/agents/jules), [apis.io](https://apis.io/providers/jules-google/)

**Linear**
- Triage Intelligence suggests team, project, assignee, labels, likely duplicates and related issues. Each team chooses show, hide or auto-apply per property. Guidance can be set at workspace, team and sub-team level. Suggestions appear in ~1–4 minutes. Business and Enterprise only (article dated June 30, 2026) — [IssueLinker](https://www.issuelinker.com/blog/linear-triage)
- Business is $16/user/mo yearly. Third-party agents (Cursor, Codegen, Sentry, etc.) take assigned issues like teammates. On Business and Enterprise, triage rules can auto-delegate to an agent. Duplicate detection is semantic; one user anecdotally reported ~85% accuracy with false positives. Triage Intelligence is still beta or "technology preview" — [Sentra](https://www.sentra.app/articles/linear-ai), [workmanagementhub](https://workmanagementhub.com/linear-agent-feature-deep-dive-2026/), [BuildBetter](https://blog.buildbetter.ai/linear-ai-agents-2026-guide-5-alternatives-for-engineering-teams/). Note: IssueLinker did not itself describe rule-to-agent delegation.

**Amp**
- Spun out of Sourcegraph in Dec 2025. Threads run in cloud sandboxes. Free Hobby tier, Individual from $20, no extra Teams charge, Enterprise custom. Editor extensions reportedly discontinued Feb 2026. Reports of an ad-supported free tier — [amplifying.ai](https://amplifying.ai/coding-agents/amp), [Tessl](https://tessl.io/blog/amp-s-new-business-model-ad-supported-ai-coding), [baeseokjae](https://baeseokjae.github.io/posts/amp-code-review-2026/). Sources are inconsistent.

**Notable 2025–2026 entrants and open-source "software factories"** (from a curated list dated Oct 31, 2026, mostly OSS) — [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)
- **Mastra Factory** (beta): connects GitHub, Linear and Slack to a board with intake → triage → planning → build → review → done stages, each set to manual or auto. Mastra's July 2026 guide describes a triage agent that classifies and routes every incoming signal — [Mastra blog](https://mastra.ai/blog/software-factory)
- **issue-graph** (vercel-labs): finds related issues, competing changes and follow-ups across a backlog, with scoring and HTML dashboards
- **shipmill**: triages GitHub issues, then fixes, reviews, releases and rolls back, with one config file setting how much is automated. **Taskuary**: an inbox that triages issues into approval-gated agent runs. **Optio**: tickets from GitHub, Linear, Jira or Notion become merged PRs via a reconciliation control plane. **Paperclip**: agents claim tickets under org charts, budgets and approval gates. **Yak**: Slack, Linear, Sentry and GitHub papercuts become PRs. **Gas Town** (Steve Yegge): a "Mayor" dispatches work to parallel agents.
- Shut down or unmaintained: Terragon (now OSS source), Bloop (Vibe Kanban community-maintained), Sweep.

### Inferences
- **Devin Automations** is the closest commercial analog to an event-driven "factory". It has the broadest trigger catalog (incl. CI check runs, GitLab pipelines, PagerDuty, generic webhooks), script or LLM preflight filters that can fan one event into many work items, and a dedicated triage agent mode. GitHub Agentic Workflows is the closest for a team already all-in on GitHub, with mature governance borrowed from Actions.
- Claude Code scheduled tasks are individually owned, so they are a poor fit for a team-owned central portal today. Anthropic's org-scale building blocks are the Agent SDK and Managed Agents, which point toward "build" rather than "buy".
- Cursor has the richest enterprise admin and spend controls among the IDE-centric vendors, but its intake and triage depend on Linear or GitHub.
- Pricing everywhere is usage-metered and hard to forecast. Only GitHub ships a first-party spend forecaster (`gh aw forecast`).

### Gaps
- Official Factory, Devin and Jules pricing pages were not fetched. Their prices come from conflicting third-party sources.
- No source found on Devin's analytics or observability dashboards for enterprise. Codex, Jules and Amp observability not found.
- The details of Factory "Signals" (what it measures, how it self-improves) were not verified from a primary source.
- Copilot coding agent's current per-task premium-request cost is unverified (the ITPro ~50-request figure is from rollout).
- Not covered: Ona (ex-Gitpod), AWS Kiro autonomous agent, Augment, OpenHands Cloud, Codegen, Tembo. My search for these returned no product-specific results.

## Q2: Which explicitly support backlog triage, ticket grouping/dedup, and ranking?

### Takeaway
No commercial product found ranks a whole backlog and decides what to work on. **Linear Triage Intelligence** is the only first-party product with explicit duplicate and related-issue detection plus auto-routing to agents. **Devin's Triage monitor** and **GitHub Agentic Workflows triage** label, route or dispatch, but rank only implicitly. Grouping and ranking is mostly found in OSS (issue-graph, shipmill, Mastra Factory) or has to be built.

### Cited Findings
- Linear Triage Intelligence suggests duplicates, related issues, team, assignee and labels, with per-property auto-apply. Priority is not listed as a suggested property — [IssueLinker](https://www.issuelinker.com/blog/linear-triage). Suggestions need human accept, decline or merge unless auto-apply is on — [Sentra](https://www.sentra.app/articles/linear-ai)
- Devin's "Triage Devin (monitor)" decides what needs attention in a Slack channel and spawns child sessions. Automations can fire on Linear "priority changed" events, so a human-set priority can drive dispatch — [Devin Docs](https://docs.devin.ai/product-guides/automations)
- GitHub Agentic Workflows triage labels issues by type and priority. "Issue Monster" hands triaged issues to Copilot every 40 minutes — [GitHub Blog](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/), [gh-aw blog](https://github.github.com/gh-aw/blog/2026-09-03-agent-of-the-day/)
- A practitioner capped triage runs at 100 AIC, 15 turns and 10 minutes because the defaults were too generous. He said prompt instructions alone don't protect a workflow, and he wouldn't use the pattern for workflows that change code or open PRs — [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)
- OSS: vercel-labs issue-graph (related-issue detection, scoring, dashboards). shipmill and Taskuary (triage into gated runs) — [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)
- An arXiv case study covers closed-loop autonomous development driven by Jira backlog orchestration with deterministic control — [arXiv 2604.05000](https://arxiv.org/pdf/2604.05000)

### Inferences
- A practical "buy" stack for the triage requirement would be: Linear (dedup and routing) + an agent vendor (Devin, Cursor or Codex) triggered by Linear labels or priority. Ranking or what-to-work-on logic would still be custom (e.g. a Devin preflight script or a gh-aw scheduled workflow).

### Gaps
- No vendor documentation found on ticket clustering or grouping beyond duplicate and related detection. No evidence of a learned prioritization model in any product.

## Q3: Which support non-engineering teams (e.g. design) or general workflow definitions?

### Takeaway
General workflow definitions exist in Devin Automations (templates, NL-generated, script preflights), GitHub Agentic Workflows (Markdown workflows), Claude Code scheduled tasks plus connectors, and Cursor Automations. None found offers a dedicated, design-team-oriented self-serve portal. Agent HQ and Linear are the closest to a centralized multi-agent hub.

### Cited Findings
- Devin automations can be created from a blank editor, about 25 templates (monitoring, CI/CD, security, project management), or natural-language generation. They connect to MCP servers and Slack or MS Teams — [Devin Docs](https://docs.devin.ai/product-guides/automations)
- gh-aw workflows are written in natural-language Markdown and cover triage, CI investigation and reporting. GitHub says conventional Actions remain better for reproducible builds and tests — [GitHub Docs](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows), [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/)
- Claude Code scheduled tasks bundle any connectors (Slack, Linear, etc.) and can be created conversationally via `/schedule`. Commentary positions them for judgment-heavy work such as triage and docs sync — [Claude Code Docs](https://code.claude.com/docs/en/routines), [Gautam Khorana](https://gautamkhorana.com/blog/claude-code-routines-vs-github-actions-cron/)
- Cursor Teams and Enterprise provide a team marketplace, team rules and skills, and group-level settings — [Cursor Pricing](https://cursor.com/pricing)
- Agent HQ is a central dashboard for assigning, steering and tracking agents from multiple vendors — [SD Times](https://sdtimes.com/ai/github-unveils-agent-hq-the-next-evolution-of-its-platform-that-focuses-on-agent-based-development/)
- UI Verify (commercial) takes screenshots of affected Storybook, Playwright or Vitest tests, compares them to baselines, and lets agents review diffs over MCP. This is a possible design-QA building block — [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)

### Inferences
- A "portal where design and engineering each set up their own pipelines" is not a product category any vendor clearly sells. Devin's per-automation config (templates, per-team Linear scoping) and gh-aw's per-repo Markdown workflows come closest. Claude Code tasks being per-user is a blocker for team-owned pipelines.

### Gaps
- No evidence found of design-team-specific workflows (e.g. Figma-triggered agents) in any of the surveyed products.

## Q4: Strengths, weaknesses and real-world feedback

### Takeaway
Feedback is mixed and mostly anecdotal. Common complaints are unpredictable usage-based cost, opaque capacity limits, and agents failing on ambiguous tickets. Strengths cluster around governance (GitHub, Cursor Enterprise, Factory Enterprise) and trigger breadth (Devin).

### Cited Findings
- Factory: strengths are enterprise compliance (SOC2, SSO, on-prem) and model flexibility. Weaknesses are hard-to-forecast token costs, vague capacity limits, self-reported benchmarks (Terminal-Bench 58.75%) and a "super frothy" market. HN: "pretty good for a cross-provider solution". Reddit: "not anything impressive" — [Ry Walker research](https://rywalker.com/research/factory-ai)
- Devin: large or ambiguous tasks burn 5–10+ ACUs and can fail to produce a mergeable PR — [usecarly](https://www.usecarly.com/blog/devin-pricing/). Automation queues drop events when full, and failed preflight scripts are not retried — [Devin Docs](https://docs.devin.ai/product-guides/automations)
- GitHub gh-aw: Accenture's Ben Alton claimed one lead saved ~29 hrs/week (measurement method unexplained). freenet's Sascha Mirow-Stanitzok cautioned against using it for code-changing workflows. ARC's privileged Docker-in-Docker sidecar was flagged as a concern — [InfoQ](https://www.infoq.com/news/2026/11/github-agentic-workflows-ga/). One community user reported classic PATs are unsupported — [GitHub Discussion](https://github.com/orgs/community/discussions/186451)
- Linear: duplicate detection ~85% accurate with false positives (single anecdote). Features are still beta — [workmanagementhub](https://workmanagementhub.com/linear-agent-feature-deep-dive-2026/)
- Jules: when tasks run out you wait, with no option to buy more — [morphllm](https://www.morphllm.com/comparisons/jules-google-coding-agent)
- Claude Code tasks: research preview, API surface may change, webhook events over caps are dropped — [Claude Code Docs](https://code.claude.com/docs/en/routines)
- Market churn: Terragon and Bloop shut down, Sweep is unmaintained — [software-factories list](https://github.com/pranshuchittora/agent-qa-software-factories-20261031)

### Inferences
- Build vs buy for this user: buying covers execution (agents in sandboxes, triggers, governance) well. The differentiating layers they want (cross-source grouping and ranking, a multi-team pipeline portal, self-measurement and improvement) are thin or absent in commercial products. A hybrid is likely: buy the execution and governance layer (GitHub gh-aw or Devin, with Linear for dedup), and build the triage-ranking and metrics layer (e.g. on the Claude Agent SDK or Managed Agents, or OSS like Mastra Factory). Compared with Warp, the key questions are whether Warp offers team-owned pipelines and a trigger breadth that matches Devin Automations or gh-aw.

### Gaps
- No rigorous independent benchmarks or customer case studies comparing end-to-end throughput or merge rates across these platforms.
- HN and Reddit sentiment was sampled only through secondary summaries; I did not fetch threads directly.
