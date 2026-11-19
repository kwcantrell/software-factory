# Build Path: Open-Source Building Blocks and Reference Architectures for an Internal "Software Factory"

Scope: an agentic SDLC pipeline with a multi-team portal. Teams submit features, issues, or CI/CD processes (stress and load tests) through a central portal. Agents triage, deduplicate, group, rank, implement, test, and review the work. Each team (design, engineering) configures its own pipeline template. Research date: 2026-11-12. Session budget was about 16 tool calls, so some components are listed under Gaps rather than verified.

## Q1. Agent runtimes and orchestrators: which fit best, and why?

### Takeaway
Production factories split the problem in two. An inner coding-agent harness (Goose, Claude Agent SDK, OpenHands SDK, or a fork of one) runs inside a sandbox. Deterministic, durable orchestration around it (Temporal or a workflow engine) handles git, lint, CI rounds, retries, and PR creation. Stripe forked Goose. Spotify built a CLI that can swap agents. Temporal has a GA integration with the OpenAI Agents SDK.

### Cited Findings
- **Stripe Minions run on a fork of Block's open-source Goose.** Stripe customized the orchestration to "interleave agent loops and deterministic code" for git operations, linters, and testing. — [Stripe Dev Blog](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- One analysis says Stripe chose an open-source base over Claude Code or Cursor Agent because it needed unattended execution. This is secondary commentary. — [MindStudio](https://www.mindstudio.ai/blog/stripe-minions-blueprint-architecture-deterministic-agentic-nodes)
- **Spotify Honk:** an internal CLI delegates prompts to an agent and can switch between agents and LLMs. Spotify says this let it swap components several times. The CLI also handles formatting and linting through local MCP, LLM-as-judge diff evaluation, log upload to GCP, and MLflow tracing. — [Spotify Engineering, Honk Part 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1)
- Third-party analyses say Honk runs Claude via Anthropic's Agent SDK in Kubernetes pods. Spotify's Part 1 post does not name the SDK. — [rywalker.com](https://rywalker.com/research/spotify-honk); [Spotify Engineering](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1). Spotify presented at Anthropic's "Code with Claude" event — [Spotify Engineering 2026/6](https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint)
- **Goose:** Apache 2.0 with no paid tier. It was donated to the Linux Foundation's Agentic AI Foundation (AAIF), announced December 2025 alongside MCP and AGENTS.md. Recipes are parameterized YAML that can run in CI/CD, and the CLI supports headless automation. — [Linux Foundation press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation?hs_amp=true); [goose docs](https://goose-docs.ai/); [rywalker.com/goose](https://rywalker.com/research/goose)
- **OpenHands Software Agent SDK:** MIT-licensed according to the team's arXiv paper (v2, April 2026). The main OpenHands repo is MIT except `enterprise/`, which has its own license (reported as PolyForm Free Trial). Some aggregators label the license "Other" or "Custom", which looks stale. — [arXiv 2511.03690](https://arxiv.org/html/2511.03690v2); [OpenHands GitHub org](https://github.com/orgs/OpenHands/repositories)
- **Claude Agent SDK:** available as Python and TypeScript libraries. Other languages can run the CLI as a subprocess with `-p --output-format json`. Use falls under Anthropic's Commercial Terms, including in customer-facing products, and products must not look like Claude Code. — [Claude Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview); [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- A third-party source reports the Python SDK repo is MIT, while the TypeScript SDK is public but governed by the Commercial Terms. Check the LICENSE file of the package you install. — [libraries.io](https://libraries.io/npm/@anthropic-ai%2Fclaude-agent-sdk); [GitHub claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- A third-party guide says the Agent SDK credit rules changed during 2026, so the terms may still be in flux. — [futureagi.com](https://futureagi.com/blog/what-is-claude-agent-sdk-2026/)
- **Temporal + OpenAI Agents SDK:** the integration reached GA on March 23, 2026, after a public preview in mid-2025. Agents run as durable Workflows and model calls run as Activities. It covers state persistence, retries, recovery, long-running tasks, and human-in-the-loop. GA integrations live in `temporalio/ai-integrations`. Temporal has also published a post on sandbox agents. — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-integration); [Temporal cookbook](https://docs.temporal.io/ai-cookbook/openai-agents-sdk-python); [Temporal sandboxes post](https://temporal.io/blog/introducing-temporal-and-agentic-sandboxes-openai-agents-sdk)
- Temporal also integrates with the Vercel AI SDK. Its stated position is that you should not build a new reliability system for each AI framework. — [Temporal blog](https://temporal.io/blog/ai-framework-integrations); [Temporal + Vercel AI SDK](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel)
- InfoQ commentary warns that integration abstractions can obscure control flow during debugging. — [InfoQ](https://www.infoq.com/news/2025/09/temporal-aiagent)
- **Shopify Roast** is an open-sourced Ruby DSL for structured, reproducible, testable multi-step AI workflows. A MindStudio piece calls it a code-review assistant, which conflicts with Shopify's announcement and appears to be wrong. — [ecommercefastlane](https://ecommercefastlane.com/introducing-roast-structured-ai-workflows-made-easy/); contradicted by [MindStudio](https://www.mindstudio.ai/blog/stripe-minions-vs-shopify-roast-ai-coding-harnesses)
- **GitHub Agentic Workflows (gh-aw):** agent workflows are authored as Markdown specs and compiled to `.lock.yml` GitHub Actions. They run read-only and make writes through "safe outputs". The project was a technical preview in February 2026 and became GA on October 28, 2026. — [GitHub changelog, GA](https://github.blog/changelog/2026-10-28-github-agentic-workflows-generally-available); [gh-aw docs](https://github.github.com/gh-aw/)

### Inferences
- Recommended layering:
  - **Outer orchestration:** Temporal (MIT, self-hostable) as the durable "factory line". It handles retries, human approval signals, multi-hour runs, and CI-round caps.
  - **Inner harness:** Goose (Apache 2.0, vendor-neutral, Linux Foundation governance) or the OpenHands SDK (MIT) for model neutrality. Choose the Claude Agent SDK if you standardize on Claude and accept the Commercial Terms.
  - **Swap layer:** like Spotify, keep a thin internal CLI or API so the harness can be replaced.
- gh-aw is the lowest-effort option if you are all-in on GitHub. Pipeline definitions are Markdown files in the repo, which suits "each team defines its own factory" well. It is less suitable as the cross-repo, portal-driven backbone.
- LangGraph, Inngest, Argo Workflows, Kestra, and Dagger are viable alternatives for the orchestration layer. This session did not verify them (see Gaps). In the case studies, the "factory" is mostly deterministic code with agent nodes, not an agent framework graph.

### Gaps
- Not verified this session: current licenses and maturity of SWE-agent, Aider, LangGraph, Inngest, Dagger (including the container-use project), Kestra, and Argo Workflows. From training knowledge, Aider, Argo, Kestra, and Dagger are Apache-2.0 and SWE-agent and LangGraph are MIT, but this needs checking against each repo.
- No source compared harness quality on a company's own tasks. Benchmark comparisons were not gathered.

## Q2. Sandboxed execution: E2B, Daytona, Modal, Firecracker, devcontainers, Kubernetes jobs

### Takeaway
Every reference factory uses pre-warmed, disposable, network-isolated environments that match human dev environments. Stripe uses devboxes that start in about 10 s, Uber uses dev pods, and Spotify reportedly uses Kubernetes pods. For self-hosting, the options are Kubernetes pods/jobs from a devcontainer image or Daytona. Managed options are E2B (Firecracker) and Modal (gVisor, with GPU).

### Cited Findings
- **Stripe devboxes:** pre-warmed and spin up "in 10 seconds", the same machine type engineers use, with code and services preloaded. They are isolated from production and the internet, which is why minions run without permission prompts. Parallel runs need no git worktrees, which Stripe says wouldn't scale. — [Stripe Dev Blog](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- **Uber Minion** runs on a dev pod with a full build environment and has monorepo access. — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development); [ZenML summary](https://www.zenml.io/llmops-database/building-internal-ai-agent-infrastructure-for-software-development-at-scale)
- **E2B:** each sandbox is a Firecracker microVM. It is managed only; the SDK is open source but the runtime is proprietary, per one source. Boots take about 200–500 ms. — [Fly.io comparison](https://fly.io/learn/sprites-vs-e2b-vs-modal-vs-daytona/); [Morph comparison](https://www.morphllm.com/comparisons/e2b-vs-daytona)
- **Daytona:** containers by default with a VM tier, and self-hostable. Cold starts take 5–15 s, warm starts are fast. Its license is reported inconsistently as Apache-2.0 or AGPL-3.0. Helix reports that a public Daytona repo was frozen; this is unverified. — [Morph](https://www.morphllm.com/comparisons/e2b-vs-daytona); [Helix](https://helix.ml/blog/self-hosted-agent-sandboxes)
- **Modal:** gVisor by default, not self-hostable. It is the main option with GPUs inside the sandbox. One source says its sandbox price is about 44% higher at full use. — [Fly.io](https://fly.io/learn/sprites-vs-e2b-vs-modal-vs-daytona/); [Novita (vendor)](https://blogs.novita.ai/best-ai-agent-sandboxes-2026/)
- Most of these comparisons are on vendor-affiliated blogs, so treat the numbers as indicative only. — [LogRocket](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/)
- Port's cross-company pattern list includes "Ephemeral environments: pools of pre-warmed, disposable sandboxes for agent sessions". — [Port, Inside the Software Factory](https://software-factories.port.io/)

### Inferences
- **Practical path:**
  1. Build the existing devcontainer or CI image as the agent image, so agents and humans share tooling. Stripe states this lesson directly.
  2. Run each task as a Kubernetes Job or pod with egress restricted to an allowlist (model gateway, package mirror, git). Add gVisor or Kata/Firecracker runtime classes if untrusted code runs.
  3. Keep a warm pool to reach cold starts under 10 s.
- Use E2B or Modal if you don't want to operate sandbox infrastructure, or need GPU (Modal).

### Gaps
- Daytona's current license and repo status could not be confirmed. Check GitHub directly.
- No primary cost data per sandbox-hour at factory scale was found.

## Q3. Developer portals as the central portal (Backstage, Port, Cortex, OpsLevel)

### Takeaway
The two practical options are Backstage plus scaffolder templates plus MCP plugins (open source, more build work) and Port (commercial, with agent-native features shipping). Both now expose self-service actions or templates as MCP tools that agents can call. Spotify connects Honk to Backstage and Fleet Management.

### Cited Findings
- **Backstage AI support (official docs):** catalog modeling of AI resources, an MCP Actions Backend that exposes Backstage functionality as tools, and published skills. — [backstage.io AI docs](https://backstage.io/docs/next/ai/)
- **Community plugins:**
  - TeraSky's Scaffolder MCP backend lets agents list and run templates. — [TeraSky](https://terasky-oss.github.io/backstage-plugins/plugins/scaffolder-mcp/backend/about)
  - A community module adds a scaffolder action that calls MCP tools. Its upstream PR #34490 was a draft. — [The Platform Log](https://theplatformlog.pages.dev/mcp-scaffolder-client)
  - `@theplatformlog/template-authoring-backend` generates Template entities from natural language. — [pkgstats](https://www.pkgstats.com/pkg:@theplatformlog/template-authoring-backend)
- Red Hat Developer Hub (a Backstage distribution) ships an `rhdh-templates` agent skill for template authoring and validation. — [Red Hat Developers, 2026-09-07](https://developers.redhat.com/articles/2026/09/07/red-hat-developer-hub-software-template-authoring-rhdh-templates)
- Backstage was reported at v1.54.0 in August 2026. A Backstage Weekly issue mentions an RFC for an `AIContext` catalog kind. — [tech-insider](https://tech-insider.org/?p=18363); [Roadie Backstage Weekly](https://roadie.io/backstage-weekly/131-context-engineering-for-developers-and-new-releases/)
- **Spotify:** Honk is connected to Backstage and Fleet Management. The Fleetshift portal plugin uses Honk for multi-repo changes. — [Spotify Portal Fleetshift](https://backstage.spotify.com/fleetshift); [Honk webinar](https://backstage.spotify.com/how-spotify-built-honk)
- **Port:**
  - Every self-service workflow is invokable as a tool through Port's MCP server. — [Port docs, expose as tool](https://docs.port.io/workflows/expose-as-tool/)
  - Guides cover triaging Jira tickets and passing only well-defined ones to coding agents, triggering Claude Code or Copilot from Port, and agent identity and permission governance. — [triage tickets to coding agents](https://docs.port.io/guides/all/triage-tickets-to-coding-agents); [trigger AI coding assistants](https://docs.port.io/guides/all/trigger-ai-coding-assistants-from-port/); [agent management](https://docs.port.io/agent-management/overview/)
  - Port Workflows is GA, and external agents including Claude can discover and call them. These are Port's own claims. — [Port blog](https://port.io/blog/port-workflows)

### Inferences
- **Mapping "each team configures its own factory" onto Backstage:**
  - A factory definition is a catalog entity, either a custom kind or a Template.
  - The pipeline template is a scaffolder Template whose steps call a custom action, e.g. `factory:start`. That action starts a Temporal workflow with parameters such as harness, model, sandbox image, review policy, CI gates, and load-test profile.
  - Team ownership comes from the catalog's `owner`. The MCP Actions Backend lets agents read the catalog and run templates.
- **Port** gets you there faster: blueprints, actions, and an AI agents/MCP surface already exist. It is SaaS and commercial.
- **Cortex and OpsLevel** were not researched this session.

### Gaps
- Cortex and OpsLevel agent integrations were not researched.
- No published case study was found of a design team configuring its own agent factory in a portal.

## Q4. Ticket triage, dedup, grouping, ranking

### Takeaway
The proven pattern is embedding retrieval of top-k candidates, then an LLM judgment that chooses merge, link, or ignore, with a human accepting the suggestion. This is what Linear does. gh-aw provides an off-the-shelf issue-triage agent. No reliable evidence was found that LLM-computed RICE or WSJF scores are accurate. Use LLMs to extract the inputs and compute the score deterministically.

### Cited Findings
- **Linear:**
  - Similar Issues uses LLM-generated vector embeddings. — [Linear blog](https://linear.app/blog/using-ai-to-detect-similar-issues)
  - Triage Intelligence is a slower, more thorough layer. It suggests duplicates, labels, and assignees. Marking a duplicate merges attachments into the canonical issue and cancels the new one. Admins can add guidance at workspace or team level, which Linear recommends doing reactively. It is available on Business and Enterprise plans. — [Linear docs](https://linear.app/docs/triage-intelligence)
- **gh-aw issue-triage agent:** classifies, sets priority labels, flags likely duplicates, and asks for missing info. It is read-only and writes through safe outputs. Install with `gh aw add-wizard githubnext/agentics/issue-triage`. Argo CD uses it. — [gh-aw gallery](https://github.github.com/gh-aw/gallery/ai-issue-triage/); [Argo CD docs](https://argo-cd.readthedocs.io/en/stable/developer-guide/github-agentics-issue-triage/)
- **Practitioner pipeline:** a FAISS top-5 candidate search, then an LLM decides merge, link, or ignore. — [DZone](https://dzone.com/articles/semantic-triage-engine-at-scale)
- **Pitfalls:**
  - Embeddings measure relatedness, not identity, so DBSCAN or agglomerative clustering produces false merges.
  - Cosine thresholds break when the embedding model version changes, so pin the model and re-validate after upgrades.
  - Extract structured fields (version, component) before vectorizing.
  - Sources: [technetexperts](https://www.technetexperts.com/fix-llm-embedding-similarity-overlap/); [weblineglobal](https://www.weblineglobal.com/blog/llm-embedding-collisions-media-deduplication)
- **Research:** GPTrace (ICSE '26) uses LLM embeddings plus clustering to deduplicate crashes and reports gains over prior methods. It is a different domain, but the method transfers. — [arXiv 2512.01609](https://arxiv.org/abs/2512.01609v1)
- **Port** documents a triage agent that evaluates and enriches Jira tickets and passes only well-defined ones to coding agents. — [Port docs](https://docs.port.io/guides/all/triage-tickets-to-coding-agents)
- **Spotify Honk:** an interactive agent in Slack or GitHub Enterprise gathers task details first, then hands a prompt to the coding agent. — [Spotify Engineering](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1)
- **Prioritization evidence is weak:**
  - Enterpret (vendor) reports raw frontier models drifted 7.5–9.8% run to run on theme counts, while a taxonomy-grounded agent was stable across 117 run pairs. — [Enterpret](https://www.enterpret.com/guides/the-5-ways-ai-native-product-teams-prioritize-instead-of-rice-ice-and-kano)
  - Grafana's SLO team dropped RICE as inaccurate and moved to a simpler 1–5 scheme called CERB. — [Grafana blog](https://grafana.com/blog/a-better-way-to-prioritize-feature-backlogs-the-cerb-scoring-method)
  - A small academic study on LLM Scrum sprint planning (backlogs of 22–25 items) found limited gains. — [Moonlight review](https://www.themoonlight.io/review/scrum-sprint-planning-llm-based-and-algorithmic-solutions)

### Inferences
- **Recommended triage pipeline:**
  1. **Normalize:** an LLM extracts component, type, repro steps, affected version, and customer count into structured fields.
  2. **Embed and retrieve** with pgvector or FAISS, using a pinned embedding model.
  3. **Judge:** an LLM pairwise decision on the top-k candidates (duplicate, related, or distinct).
  4. **Group:** connected components over "duplicate" edges only, not raw clustering. Use HDBSCAN over "related" edges for theme grouping.
  5. **Score:** the LLM estimates each input with a rationale (reach from customer-request counts, effort from codebase analysis, confidence). The score is computed by code, and humans can override.
  6. **Agent-readiness gate:** like Port and Spotify, only well-specified, small-scope tickets go to coding agents. The rest go to humans or to a "clarify" step that asks the reporter.
- Use the agent-ready decision, not the priority score alone, to decide what agents work on. Stripe and Spotify both started with migrations, flaky tests, and well-scoped tasks.

### Gaps
- No peer-reviewed study was found validating LLM-produced RICE or WSJF scores.
- No published false-merge rates were found for Linear's or GitHub's dedup.

## Q5. Integrating CI/CD jobs such as stress and load tests (k6, Locust)

### Takeaway
Treat load and stress tests as deterministic pipeline steps that agents can trigger and read results from, through MCP or portal actions. Don't let agents freely design them. Stripe's pattern of a fast local check, selected CI, and at most two CI rounds is the reference for feedback loops.

### Cited Findings
- **Stripe's feedback loops:**
  - Lints run on push in under 5 s.
  - CI runs selected tests from more than 3M, and known autofixes apply automatically.
  - Failures go back to the minion, capped at "at most two rounds".
  - CI creates flaky-test tickets with a button that launches a minion.
  - Source: [Stripe Dev Blog](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- **k6 MCP options:** Grafana has an official experimental Go MCP server, `mcp-k6`, according to a DEV Community comparison; this was not verified against the Grafana repo. Third-party hosted MCP bridges to Grafana Cloud k6 expose start/stop run and get-run-thresholds, and could gate a deployment. — [DEV Community](https://dev.to/grove_chatforest/performance-load-testing-mcp-servers-k6-jmeter-locust-gatling-artillery-lighthouse-pm8); [Vinkius](https://vinkius.com/apps/grafana-k6-cloud-load-testing-mcp)
- **Port** exposes every self-service workflow (which could include a load-test run) as an MCP tool for agents. — [Port docs](https://docs.port.io/workflows/expose-as-tool/)
- **Uber:** Autocover generates more than 5,000 unit tests per month, and Shepherd manages migrations end to end. — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development)

### Inferences
- **Design for load and stress tests:**
  1. Each team registers "process templates" in the portal: a k6 or Locust script, target environment, thresholds, and schedule or trigger.
  2. Execution is a deterministic Temporal activity, Argo Workflow, or k6-operator job. k6 thresholds give pass/fail exit codes.
  3. Agents interact in three ways:
     - **Consume:** read k6 threshold results and summaries to file regressions or block merges.
     - **Trigger:** call the process as an MCP tool when a change touches hot paths.
     - **Author:** draft new k6 scripts as a PR, reviewed like code.
  4. Never let an agent target production without a human approval signal in the workflow.

### Gaps
- The grafana/mcp-k6 repo, its maturity, and the Locust equivalent were not verified.
- No case study was found of agents autonomously running load tests in a company factory.

## Q6. Reference architectures, case studies, and effort/cost

### Takeaway
Stripe (Minions), Spotify (Honk), and Uber (Minion) are verified, well-documented internal factories. All three reuse years of existing dev infrastructure: devboxes, Fleet Management, CI, and an MCP gateway. The agent is the smallest part. Common building blocks are a background agent, an MCP gateway, pre-warmed sandboxes, quality gates, spend control, and agent identity.

### Cited Findings
- **Stripe:**
  - More than 1,000 merged PRs per week are fully minion-produced, with human review and no human-written code. Secondary sources say about 1,300.
  - Triggers: Slack (most common), CLI, web UI, docs platform, feature-flag platform, and the ticketing UI.
  - Toolshed, the internal MCP server, has more than 400 tools.
  - Uses conditional rule files per subdirectory.
  - Pre-hydrates context by running MCP tools deterministically over links before the agent starts.
  - Agents use the same tooling as humans.
  - Sources: [Stripe Dev Blog](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents); [ByteByteGo](https://blog.bytebytego.com/p/how-stripes-minions-ship-1300-prs); [InfoQ](https://www.infoq.com/news/2026/03/stripe-autonomous-coding-agents)
- **Spotify Honk:**
  - More than 1,500 agent PRs merged (Part 1, November 2025), used by hundreds of developers.
  - About half of Spotify's PRs since mid-2024 come from Fleet Management automation.
  - Migrations show 60–90% time savings.
  - A previous deterministic Maven updater grew past 20k lines.
  - Open challenges: latency, unpredictability, safety, and cost.
  - Sources: [Spotify Engineering Part 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1); [Part 4](https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4)
  - One headline claims 1,000 PRs in 10 days; this is secondary. — [InfoQ talk](https://www.infoq.com/presentations/spotify-ai-codebase-migration-agent/); [neura.market](https://neura.market/news/spotify-honk-ai-agent-merges-1000-prs-in-10-days)
  - Commentary argues "Honk is 15 years of infrastructure". — [ninetwothree](https://ninetwothree.co/blog/honk-spotify-ai-infrastructure)
- **Uber:**
  - Minion is a background agent platform with monorepo access, opening about 11% of PRs as of March 2026.
  - AIFX CLI provisions Claude Code, Codex, and Cursor with central defaults.
  - MCP Gateway exposes Thrift, Protobuf, or HTTP endpoints as MCP through config, with central auth and telemetry and a registry.
  - Agent Builder and Agent Studio are no-code agent builders with tracing and evals.
  - Other tools: uReview, Autocover, Shepherd, and Code Inbox.
  - Adoption: 84–92% of developers use agents.
  - AI costs are up 6x since 2024, and token cost is a growing concern.
  - Sources: [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development); [Ona, Background Agents Summit](https://ona.com/stories/background-agents-summit)
- **Port's cross-company synthesis** covers 13 companies, including Stripe, Uber, Shopify, Ramp, Cloudflare, DoorDash, Monzo, and Zalando. It names nine patterns: internal MCP gateway, spend control, background agent, model router, shared agent context, quality gate, ephemeral environments, identity layer, and guardrail layer. Port is a vendor. — [Port, Inside the Software Factory](https://software-factories.port.io/)
- **Background Agents Summit** (May 2026), with Uber and Stripe speakers, and Ona's background-agents white paper. — [background-agents.com](https://background-agents.com/summit/sessions/nikhil-ramakrishnan/); [Ona white paper](https://ona.com/files/background_agents_white_paper.pdf)

### Inferences
- **Reference architecture (buildable, mostly open source):**
  1. **Portal:** Backstage (Apache 2.0, CNCF) with custom "Factory" templates per team, or Port (commercial).
  2. **Intake and triage service:** webhooks from portal, GitHub, Jira, and Slack, feeding the Q4 pipeline backed by Postgres and pgvector. gh-aw issue-triage can cover GitHub-native repos.
  3. **Orchestrator:** Temporal. Each factory template becomes a workflow definition: intake → spec/clarify → plan → implement (agent activity) → local lint/test → CI (at most 2 rounds) → LLM-judge review → human review → merge. Optional load-test and perf gates and design-review steps vary per team.
  4. **Agent harness:** Goose, the OpenHands SDK, or the Claude Agent SDK behind an internal "agent CLI" swap layer, as at Spotify.
  5. **Sandbox:** Kubernetes Jobs from the team's devcontainer image with a warm pool and egress lockdown, or E2B or Modal managed.
  6. **Context and tools:** an MCP gateway to internal APIs (as at Uber and Stripe), AGENTS.md or rule files per directory, and context pre-hydration.
  7. **Governance:** model gateway or router with per-team budgets, agent identities (scoped GitHub App tokens), tracing (OpenTelemetry or MLflow), and evals.
- **Effort (rough inference, no primary cost data found):**
  - **MVP:** 2–4 engineers for one quarter. One factory template, GitHub-only, the gh-aw triage starter, Temporal, Goose or Claude Agent SDK in Kubernetes Jobs, and Backstage with one custom action.
  - **Multi-team production with dedup/ranking, load-test gates, and governance:** plausibly a 4–8 person platform team over 6–12 months.
  - The case studies show the largest hidden cost is pre-existing infrastructure: devboxes, fast CI, and test selection.
  - Token spend is a material ongoing cost; Uber reports AI costs up 6x since 2024.

### Gaps
- None of the case studies published headcount or build cost. The effort estimates above are inference only.
- The Port Software Factory profiles of Shopify, Ramp, and others were not opened individually.
- Spotify Honk Parts 2 (context engineering) and 3 (feedback loops) were not fetched.
- The Uber Minion architecture details are behind the Pragmatic Engineer paywall.
