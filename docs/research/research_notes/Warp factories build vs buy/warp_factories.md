# Warp Factories (and the Warp agent platform): what it is, how it works, and how well it fits

Researched 2026-11-12. Most of these facts come from docs.warp.dev, which was still labeling Factories "Early Access" in its navigation. Treat every detail as beta and subject to change. The config schema is `v1alpha1`.

## What is a Factory? Core concepts, config format, triggers, execution, and models

### Takeaway
A Warp Factory is a set of cloud-agent workflows defined as code (YAML plus Markdown, rooted at `factory.yaml`) for one group of repositories. A coordinating "foreman" agent routes each work item through default triage, spec, implement, and review agents. Work can arrive from Slack, Teams, GitHub, GitLab, Azure DevOps, Linear, Jira, cron schedules, custom webhooks, the API, or a local coding agent through the Factory MCP. Runs execute on Warp-hosted cloud sandboxes by default. Enterprise customers can self-host execution. Factories are multi-model and multi-harness, so Warp Agent, Claude Code, and Codex can all be used.

### Cited Findings
- Warp describes Factories as "open, flexible infrastructure for building your own software factory." You define development workflows as code, connect them to your repos and tools, and measure results with evaluation and benchmarks. A "factory" is the system of workflows you configure. — [Warp Docs: Factories](https://docs.warp.dev/factories/)
- Core concepts:
  - **Work item**: one request, such as an issue, support thread, PR, scheduled job, or Factory MCP task. It keeps its identity and source context from intake to handoff, across any number of agents.
  - **Foreman**: coordinates the work and talks to humans. It shares the factory's handle, so a factory named `payments` is addressed as `@payments` in Slack or Linear.
  - **Stages and checkpoints.**
  - **Factory definition.**

  — [Warp Docs: Factories](https://docs.warp.dev/factories/), [How factories work](https://docs.warp.dev/factories/how-factories-work/)
- Sizing guidance: put repositories that ship together in one factory, and keep separate products in separate factories (for example main app, marketing site, data pipelines). Warp says not to split one repo set by team or task. Use custom agents and skills to specialize instead. — [Warp Docs: Factories](https://docs.warp.dev/factories/)
- **Config format.** The definition is a versioned tree of YAML and Markdown rooted at `factory.yaml`, with `schemaVersion: v1alpha1`, `name`, `repositories` (owner/name, plus `codeForge` when there are multiple forges), and `agentDefaults` (exactly one of `model` or `harness`, for example `model: auto`). — [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- Layout:
  - `agents/<name>/agent.md`: YAML frontmatter (`agentType`, `model`/`harness`, `runner`, `secrets`, `mcpServers`) followed by the prompt body
  - `agents/<name>/skills/`
  - `automations/<name>/automation.md`: frontmatter `triggers` plus a starting prompt
  - `runners/<name>.yaml`: platform OS/arch and `instanceShape` (vCPU and memory)
  - `routers/<name>.yaml`: model routers
  - `benchmarks/<suite>/suite.yaml` and `tasks/*.yaml`
  - `scorers/<name>/scorer.md`
  - `skills/<name>/SKILL.md`
  - `webhooks/<name>.yaml`

  MCP servers take exactly one of `warpId`, `command`, or `url`. Secrets are referenced as `{{SECRET_NAME}}` and their values are never stored in the definition. — [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- Warp validates the whole definition and applies it as a single unit. If validation fails, the last valid definition stays in effect. JSON Schemas are published at `app.warp.dev/api/v1/factory-files/schemas`, and the examples repo includes a `validate_factory_files.py` script. Existing runs keep their original settings. — [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- Definitions are stored in one of two ways:
  - **Warp-managed** (the default): edited in the web app. Warp validates, commits, and applies changes.
  - **GitHub-backed** (paid plan): merges to `main` update the factory, and PRs run a `warp/factory-config` check.

  — [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- Example repo: https://github.com/warpdotdev/warp-factory-examples — [Warp Docs: Factories](https://docs.warp.dev/factories/)
- **Triggers.** Each automation trigger names a provider and an event:
  - **Linear**: issue_labeled, created, assigned, or state_changed; comment_created; agent_session_created.
  - **Slack**: app_mention, message_posted, DMs, reaction_added, and more.
  - **GitHub**: many issue and PR events, plus CI events `push`, `check_suite_completed`, `workflow_run_completed`, `commit_status`, and rerequested events.
  - **GitLab**: bot_mentioned, merge_request, push.
  - **Azure DevOps**: PR and work-item events.
  - **Jira**: issue_created, issue_labeled, status_changed, agent_session_created.
  - **Teams**: app_mention, message_posted.
  - **`factory`**: work_item_stage_changed, filterable by stage.
  - **`schedule`**: `cron_fired`, using 5-field UTC cron, `@daily`, or `@every 1h`.
  - **`webhook`**: `received`, with JSON payload pattern filters.

  Filters are AND-combined and support `in`/`not_in`. Keyword matching is a case-insensitive substring match, not a regex. — [Automation triggers](https://docs.warp.dev/factories/automation-triggers/)
- Example CI trigger: `provider: github, event: check_suite_completed, filter: {repos: [acme/api], conclusions: [failure]}`. Warp has no separate CI provider; CI signals come from GitHub events. — [Automation triggers](https://docs.warp.dev/factories/automation-triggers/)
- **Execution.** Every agent run is an ordinary cloud agent run on Warp's "Automation Platform." Runs use Warp-hosted compute by default, and Enterprise can keep checkout and execution on its own infrastructure through managed self-hosting. The docs list Docker, Kubernetes, "direct", and external-orchestrator options, plus a private container registry. — [Warp Docs: Factories](https://docs.warp.dev/factories/) (sidebar)
- During a run, "View session" opens the live shared agent session while the sandbox is active, and the transcript afterwards. — [Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/)
- **Models and harnesses.** Factories support many models and harnesses, including open-weight models, Claude Code, and Codex. Agents can use computer use on Linux and Mac to verify changes. "AI sovereignty" options include BYO inference and hosting, self-hosted data, and ZDR. — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)
- The pricing page names Fable 5, Claude Opus 5, GPT-5.6, Gemini 3.1 Pro, GLM 5.2, and Kimi K3, among others. Claude Code and Codex harnesses start at the Factories Build tier. — [Warp pricing](https://www.warp.dev/pricing)
- **Relationship to Oz.** Existing standalone cloud-agent workflows keep their current Oz web app, `oz` CLI, SDKs, and API. New software factories start in the Warp Factories web app. The SDK packages are now `warp-platform-sdk` (Python) and `@warp-dot-dev/warp-platform-sdk` (TS), and the `oz` and `warp` binaries have separate CLIs. No deprecation dates are stated. — [Transitioning from Oz](https://docs.warp.dev/platform/transitioning-from-oz/)

### Inferences
- In this model one factory equals one product or repo-set, with a team-owned config-as-code repo. That maps well to "each team sets up its own factory," and a design team could get its own factory if it owns separate repos. Warp explicitly discourages splitting one repo set by team, though. It recommends doing that with custom agents and skills inside one factory.
- "Oz" appears to be the earlier brand for Warp's cloud agent platform (web app, CLI, SDK). Factories sits on top of it as the "Automation Platform." The docs do not define this explicitly.

### Gaps
- I did not fetch the full list of model IDs available inside factories, or the router semantics.
- Concurrency, queueing, and rate limits are not documented on the pages I read.

## Does it cover intake → triage → grouping/ranking → implementation → review → deploy?

### Takeaway
The built-in pipeline covers intake, triage of each issue, spec, implementation, review, optional UI verification, and handoff of a PR. It stops at the human merge. Backlog-wide grouping, ranking, and "agents decide what to work on" are not built-in or documented, and neither is deploy or monitoring. You would have to build those yourself as custom agents or automations, for example a scheduled cron agent that scans the backlog.

### Cited Findings
- Lifecycle stages:
  - Triage → Planning (optional) → Building → Reviewing → Human handoff → Complete or Cancelled.
  - A revision loop runs from Reviewing back to Building and continues the existing agent conversations.
  - An item becomes Complete only after the merge is confirmed.
  - The foreman "picks the shortest path that still meets your quality policy" and can skip triage or spec.

  — [How factories work](https://docs.warp.dev/factories/how-factories-work/)
- The docs frame the loop as triage, spec, implement, review, verify, ship, and monitor, with human checkpoints for spec, code, and product. — [Warp Docs: Factories](https://docs.warp.dev/factories/)
- In practice the documented lifecycle ends at merge. — [How factories work](https://docs.warp.dev/factories/how-factories-work/)
- What each default agent produces:
  - Triage agent: researches the request, reproduces the problem, and defines scope and complexity.
  - Spec agent: product behavior, constraints, and validation criteria, delivered in a draft PR.
  - Implement agent: a branch and PR with test and visual evidence.
  - Review agent: an advisory verdict.

  — [How factories work](https://docs.warp.dev/factories/how-factories-work/), [End-to-end SDLC](https://docs.warp.dev/factories/use-cases/end-to-end-sdlc-automation/)
- Default checkpoints are spec approval, clarifying questions, and merge. The first two are policy in the foreman's editable instructions. "The factory never merges on your behalf." Merge is governed by branch protection. — [How factories work](https://docs.warp.dev/factories/how-factories-work/)
- Triage works on one issue at a time. A skill defines allowed categories and priorities (the example assigns `P1` plus labels), along with duplicate search and reproduction procedures. The docs do not mention grouping, ranking across the backlog, or a scheduled backlog sweep, and every documented triage trigger is event-based. — [Issue triage use case](https://docs.warp.dev/factories/use-cases/issue-triage/)
- In the end-to-end use case, work enters when a maintainer applies an intake label, which "selects work for the factory." Triage reports a priority, but the docs do not say how priority affects ordering. — [End-to-end SDLC](https://docs.warp.dev/factories/use-cases/end-to-end-sdlc-automation/)
- How the factory picks among many candidate items is not documented. Only automation filters and schedules select work. — [How factories work](https://docs.warp.dev/factories/how-factories-work/)
- Deploy and monitoring stages are not part of the documented lifecycle. Separate pages exist for a Vercel webhook and a "production incident resolution" use case, which I did not read in depth. — [End-to-end SDLC](https://docs.warp.dev/factories/use-cases/end-to-end-sdlc-automation/)
- Built-in pieces: the default agents, stage order, checkpoints, the dashboard, Scorers, Self-improvement, and Benchmarks. User-defined pieces: agents, automations, runners, scorers, skills, webhooks, models and harnesses, foreman instructions, and repo permissions. — [How factories work](https://docs.warp.dev/factories/how-factories-work/)

### Inferences
- The "agents group and rank tickets and decide what to work on" requirement would have to be built on Warp as a custom agent. One way: a `schedule` cron automation runs a "planner" agent that queries Linear or GitHub through MCP, clusters and ranks issues, and applies the `factory-ready` label to the top N. That label then triggers the standard pipeline. This is feasible with the documented primitives, but you would own the logic.
- "Set up stress tests as CI/CD processes" maps to `schedule` or GitHub `workflow_run_completed`/`check_suite_completed` triggers (filtered to `conclusions: [failure]`) that open work items. The stress test itself still runs in your CI. Warp reacts to the results; it is not a CI runner.

### Gaps
- I did not read the production-incident and Vercel webhook pages in detail.
- Queue ordering and priority semantics are not documented.

## Multi-team and org features: workspaces, permissions, portal, templates

### Takeaway
Factories are created and managed in a central web app, the "Factory Home" control room. Roles are Factory user, Editor, and Admin, assignable team-wide or per factory, but role assignment requires Enterprise. On other plans every member is an Editor. "Workspaces to organize factories across teams" is listed only on Enterprise. Templates are shared through Git or the examples repo rather than a template marketplace.

### Cited Findings
- Roles:
  - **Factory user**: can view and run work.
  - **Editor**: can edit the definition and attach secrets, MCPs, and integrations.
  - **Admin**: can also manage roles and delete the factory.

  — [Permissions](https://docs.warp.dev/factories/permissions/)
- Team and workspace admins inherit Admin. Factory-specific roles override team-wide roles. Creating a factory requires the team-wide Editor or Admin role. — [Permissions](https://docs.warp.dev/factories/permissions/)
- "Assigning Factory user and Editor roles requires an Enterprise plan. On other plans, all team members have Editor access." — [Permissions](https://docs.warp.dev/factories/permissions/)
- Factory roles do not grant access to repos or external services. That access depends on the run's repository identity, secrets, and MCPs. — [Permissions](https://docs.warp.dev/factories/permissions/)
- Enterprise includes "workspaces to organize factories across teams," self-hosted workers, compute, and transcripts, BYO AI provider, and custom shared usage pools. — [Warp pricing](https://www.warp.dev/pricing)
- Cross-factory views: Runs, MCPs and apps, Secrets, and Integrations span the whole team. Home is a personal page across all accessible factories, with a "Waiting on you" filter for questions, spec approvals, and PR reviews. The docs do not describe a cross-factory metrics dashboard. — [Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/)
- The launch blog describes a "control room" web app for monitoring runs, work-item status, and automations. — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)

### Inferences
- A portal where different teams each set up their own factories is supported in principle. Real isolation and RBAC between teams (design vs engineering) effectively requires Enterprise.
- Shared standards across factories would need to be distributed through Git, for example a shared skills repo or the examples repo, since there is no documented template gallery.

### Gaps
- I found no documented factory-count limits per plan.
- I found no template or marketplace feature.
- Org-wide metrics roll-up across factories is not documented.

## Observability and self-improvement

### Takeaway
Observability is a meaningful differentiator. The per-factory dashboard reports Autonomy, PR cycle time by stage, and cost per PR split into compute, platform, and inference. Run timelines include sub-agents and transcripts. On top of that sit LLM-judge Scorers, Benchmarks that compare configurations on fixed tasks, and a Self-improvement loop that turns repeated scorer failures into PRs against code or factory config for human review. This is the closest match to "the system measures and improves itself."

### Cited Findings
- Dashboard metrics:
  - **Autonomy**: the share of merged PRs that needed no human code push.
  - **PR cycle time**: median from kickoff to PR, first review, and merge, with per-stage medians.
  - **Cost per PR**: median, with the cost of child runs split across PRs. It is an estimate, not an invoice.
  - **Charts**: opened vs merged PRs, a run breakdown, cost split into compute, platform, and inference, a "most expensive PRs" list, and Scorer cards.

  — [Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/)
- Run detail shows a timeline, cost, and a Sub-agents tab. Related runs group under their parent. The docs do not describe metrics export. — [Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/)
- Scorers use an LLM judge to classify completed runs against criteria you write (example: "did the agent run tests before opening a PR"). The recommended calibration is to score a few runs manually and compare the judge's results with your own. — [Measure & improve](https://docs.warp.dev/factories/measure-and-improve/)
- Benchmarks compare model and runner configurations for one agent on fixed tasks before you change production. The format is `benchmarks/<suite>/suite.yaml` plus task YAMLs. — [Measure & improve](https://docs.warp.dev/factories/measure-and-improve/), [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- Cost metric caveats: historical estimates and incomplete coverage of external inference affect the numbers. PR metrics require a connected code host and only cover activity after you connect it. — [Measure & improve](https://docs.warp.dev/factories/measure-and-improve/)
- How Self-improvement runs:
  - It is enabled per Scorer.
  - A run starts when an agent reaches 25 distinct unreviewed failures, or when its oldest unreviewed failure is 7 days old. GitHub-backed factories can set `selfImprovement.failedRunThreshold` from 1 to 50.
  - The run groups failures and proposes fixes to application code and, for definitions-as-code, to factory prompts, skills, and config, as PRs.
  - Each PR has a "Regressions addressed" section linking the evidence.
  - Reviewers are chosen by `reviewerType` (admins, team, none, or custom).
  - "Run now" triggers it on demand, but you cannot choose which agents or failures it processes.
  - Nothing is adopted without review.

  — [Self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/)
- The launch blog mentions "self-improvement loops using observer agents." Its dashboard image shows $57.55 cost per PR, 93% code quality, and 96% efficiency for April–July, and the blog does not say whether those figures are real or illustrative. — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)

### Inferences
- The improvement loop only optimizes against Scorer criteria you write. Throughput or business metrics do not feed it directly, and there is no documented automatic A/B test or canary that connects Benchmarks to Self-improvement.

### Gaps
- I found no documented export or OpenTelemetry for factory metrics. Self-hosting has a "monitoring" page that I did not read.
- I did not read the Scorer file schema in detail.

## API, CLI, SDK extensibility and integrations

### Takeaway
Warp offers a REST API with factory endpoints, Python and TypeScript SDKs, a CLI, custom webhooks, and a Factory MCP that local agents can use to push and pull work. Native integrations cover Slack, Teams, GitHub, GitLab, Azure DevOps, Linear, and Jira. GitHub Actions connects through GitHub check, workflow, and status events rather than a dedicated Action.

### Cited Findings
- Integrations: Slack, Microsoft Teams, GitHub, GitLab, Azure DevOps, Linear, and Jira. Results return to the originating thread, issue, or PR. Other entry points are custom webhooks and factory endpoints, automations, and the Factory MCP, which lets a local coding agent send work to a factory, take it over locally, and hand it back. — [Warp Docs: Factories](https://docs.warp.dev/factories/)
- The launch blog advertises a "complete API, SDK, and CLI." — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)
- Factory endpoints submit new work. Agent and run endpoints inspect, continue, or cancel runs. SDK packages are `warp-platform-sdk` (Python) and `@warp-dot-dev/warp-platform-sdk` (TS). — [Transitioning from Oz](https://docs.warp.dev/platform/transitioning-from-oz/)
- Docs include an SDK demo of Sentry monitoring and a Vercel webhook page. — [Warp Docs: Factories sidebar](https://docs.warp.dev/factories/)
- Teams and Azure DevOps support was announced in a later blog post. — [Warp blog](https://www.warp.dev/blog/warp-factories-microsoft-teams-azure-devops) (seen in search results only; not fetched)
- The Warp client is open source, but the server and orchestration layer are proprietary. — [The New Stack](https://thenewstack.io/warp-software-factory-infrastructure/), as summarized in search results (fetching the page returned 403)

### Gaps
- I did not read the API reference, and I could not verify endpoint details or rate limits.

## Pricing, maturity, launch, limitations, and reception

### Takeaway
Factories launched on Aug 18, 2026 as a closed beta / Early Access product. As of Nov 2026 it is still Early Access. A Warp offsite post says it is "transitioning to GA" but gives no date. The pricing page now lists Factories tiers, and usage is billed separately on top of seat fees. Independent user reviews are essentially nonexistent: coverage is press plus Warp's own SEO articles, and I found no substantive HN or Reddit threads.

### Cited Findings
- Launch: announced Aug 18, 2026 as a closed beta, with a limited number of companies onboarding. Qualified organizations get $10k of factory usage free. Setup takes "under five minutes." — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory), [Fortune press release](https://fortune.com/press-releases/warp-launches-warp-factories-automate-software-development-2026-08-18/)
- Docs navigation labels Factories "Early Access," and the quickstart points to a request-access page. — [Warp Docs: Factories](https://docs.warp.dev/factories/), [request access](https://warp.dev/factories/request-access)
- Warp's offsite blog says Factories "is transitioning from Early Access to general availability," with no date given. — [Warp team offsite fall 2026](https://www.warp.dev/blog/warp-team-offsite-fall-2026) (search snippet only; not fetched)
- A third-party tracker says the docs changelog lists Early Access on Aug 27, 2026, which conflicts with the Aug 18 launch date. — [usagepricing.com](https://www.usagepricing.com/blueprint/activity/warp-2026-08-packaging) (search snippet; unverified)
- Factories pricing tiers. Usage is "billed separately based on inference, compute, and agent usage."

  | Tier | Price | What's included |
  |---|---|---|
  | Pay as you go | $0 | Usage at 20% above API rates; built-in and custom agents; automations and insights; Warp-hosted factory-as-code and runners |
  | Build | $20/mo | Usage at API rates; Claude Code and Codex harnesses; GitHub-backed factory-as-code; attribution controls; multiple admins |
  | Business | $50/user/mo | SAML SSO; telemetry and content controls; expanded insights; BYO API keys and custom inference endpoints |
  | Enterprise | Custom | Shared usage pools; BYO AI provider; self-hosted workers, compute, and transcripts; workspaces across teams |

  — [Warp pricing](https://www.warp.dev/pricing)
- Warp says it automates about 30–35% of its own tasks weekly with factories, and that many tasks still need a human in control. CEO Zach Lloyd says the primary target is smaller companies that lack the resources to build a factory themselves. TechCrunch cites Stripe "minions" and Ramp's background agent as in-house analogues. — [TechCrunch](https://techcrunch.com/2026/08/18/warps-new-system-is-an-out-of-the-box-software-factory-for-ai-development/)
- The config format is `v1alpha1` and may change. — [aiunderstanding.org](https://aiunderstanding.org/news/warp-opens-early-access-to-factories-a-config-as-code-system-for-running-fleets-of), [Factory as code](https://docs.warp.dev/factories/factory-as-code/)
- The launch blog names no customers and includes no testimonials. Its performance and ROI claims are self-reported. — [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)
- A search for HN and Reddit discussion of Warp Factories found none. Results were vendor content (many Warp SEO "articles," such as "Warp Factories vs Factory.ai") and news coverage (It's FOSS, eWeek, The New Stack, Fortune press release). — [It's FOSS](https://itsfoss.com/news/warp-factories-launched/), [eWeek](https://eweek.com/news/warp-ai-software-factory/), [Warp vs Factory.ai](https://www.warp.dev/articles/warp-factories-vs-factory-ai)
- Documented limitations:
  - No automatic merge.
  - The validator script does not cover routers, benchmarks, webhooks, or skills.
  - Webhook `authMode` cannot be changed in place.
  - Self-improvement cannot target specific agents or failures.
  - Cost metrics are estimates.
  - Computer-use verification is Linux and Mac only.
  - GitLab has no native issue-created trigger.

  — [Factory as code](https://docs.warp.dev/factories/factory-as-code/), [Self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/), [Issue triage](https://docs.warp.dev/factories/use-cases/issue-triage/), [Warp launch blog](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)

### Inferences (fit for the user's goal)
- **Strong fit:**
  - Config-as-code factories per product or team
  - Intake from Linear, Jira, GitHub, and Slack, plus CI-failure and cron triggers
  - The default triage, spec, implement, and review pipeline with human checkpoints
  - A central web portal
  - Cost and autonomy metrics
  - LLM-judge scorers, benchmarks, and a self-improvement PR loop
  - Bring-your-own harness (Claude Code or Codex)
- **Weak or missing:**
  - Backlog-level grouping, ranking, and autonomous work selection, which you would build as a custom cron agent
  - Deploy and monitor stages beyond webhooks and incident use cases
  - Per-team RBAC and workspaces, which are Enterprise-only
  - GA maturity: the product is Early Access with a v1alpha1 schema
  - Vendor lock-in: the orchestration server is proprietary
  - Independent validation or reviews
- **Build-vs-buy angle:** Warp gives you the hosted runtime, sandboxes, integrations, dashboards, and eval loop. The pieces you would differentiate on, ticket clustering and ranking plus the cross-team portal and metrics roll-up, are mostly not provided and would be custom agents on top of it.

### Gaps
- No public GA date.
- I found no published concurrency limits or per-run cost examples beyond the sample dashboard.
- I could not find independent user reviews or HN or Reddit threads.
