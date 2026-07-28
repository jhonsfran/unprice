# Unprice SDK Agent Skill Design

Date: 2026-07-28

Status: approved in conversation

## Goal

Publish one portable agent skill that helps coding agents integrate `@unprice/api` into customer
applications correctly. The skill must be installable from the public Unprice repository, exposed
through the Mintlify docs site, and discoverable by skills-compatible agents.

The skill is an implementation playbook, not a copy of the SDK reference. It owns operation
selection, integration workflow, safety rules, and verification. The generated SDK types and
OpenAPI document remain authoritative for exact request and response shapes.

## Success Criteria

- A user can install the skill from the Unprice GitHub repository with the `skills` CLI.
- A user can install the same canonical skill from `https://docs.unprice.dev`.
- The metadata triggers for Unprice SDK integration, review, and troubleshooting tasks.
- The skill distinguishes `access.check`, `usage.consume`, `usage.record`, and budgeted runs.
- Generated code keeps the API token server-side, handles `{ result, error }`, and uses stable
  idempotency keys.
- Budgeted-run examples end failed or rejected runs with `status: "failed"` and release unused
  funds in `finally`.
- The skill stays compact by loading detailed patterns and verification guidance from references
  only when needed.
- Local validation proves the skill is structurally valid and discoverable.

## Current State

Mintlify already generates `https://docs.unprice.dev/skill.md` from the documentation. That gives
Unprice a useful zero-maintenance capability summary, but it is not the canonical implementation
guide:

- generated content can lag or disagree with the checked-in SDK surface;
- the current generated budgeted-run example ends with `status: "completed"` even when a consume
  call throws or is rejected;
- the current `name: Unprice` frontmatter is less portable than a lowercase, directory-matching
  skill name;
- the generated skill describes product capabilities more than the workflow for editing and
  verifying a consumer project.

The repository already has the stable sources needed to author the skill:

- `apps/docs/quickstart/choose-operation.mdx` owns runtime-call selection;
- `apps/docs/quickstart/onboarding-customer.mdx` owns customer provisioning guidance;
- `packages/api/README.md` owns the SDK entrypoint and result-handling pattern;
- `packages/api/src/generated/sdk-resources.ts` enumerates the generated public SDK surface;
- `apps/docs/openapi.json` owns exact public operation contracts.

## Considered Approaches

### 1. Keep the Mintlify-generated skill

Rely on `/skill.md` and make no repository changes.

Trade-off: no maintenance, but no deterministic review or tests. Generated examples can contain
subtle lifecycle mistakes and are not coupled to SDK validation.

### 2. Add a canonical skill to the Unprice repository — selected

Store the skill under `skills/integrate-unprice-sdk/` and expose that same directory through
Mintlify's custom-skill discovery.

Trade-off: SDK changes may require small skill updates, but the skill can be reviewed and validated
in the same pull request. GitHub and docs installations receive identical content.

### 3. Create a dedicated `unprice-skills` repository

Publish skills independently from the product monorepo.

Trade-off: cleaner independent releases, but weaker coupling to the SDK and a larger drift risk.
This is unnecessary while Unprice has one public consumer-integration skill.

## Architecture

```text
skills/integrate-unprice-sdk/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── references/
    ├── operation-selection.md
    ├── integration-patterns.md
    └── verification.md

apps/docs/.mintlify/skills -> ../../../skills
```

`SKILL.md` contains the trigger description, core workflow, non-negotiable safety rules, and
reference routing. It stays below 500 lines and does not duplicate detailed examples.

`references/operation-selection.md` explains the commercial behavior of the four runtime paths:

| Need | Operation |
| --- | --- |
| Read-only preflight or shadow comparison | `access.check` |
| Synchronous enforcement for known usage | `usage.consume` |
| Asynchronous metering and evidence | `usage.record` |
| Up-front budget for multi-step work | `runs.start` / `runs.consume` / `runs.end` |

`references/integration-patterns.md` contains concise TypeScript patterns for client creation,
customer mapping, error/denial handling, idempotency, and budgeted-run cleanup. Examples use only
stable SDK concepts; agents must inspect installed SDK types for exact shapes.

`references/verification.md` defines a focused review and test checklist. It tells the agent to use
the host project's package manager, test conventions, and smallest relevant validation commands.

`agents/openai.yaml` provides optional Codex UI metadata. It does not add runtime requirements and
other skill clients may ignore it.

The Mintlify symlink prevents a second copy of the skill. The top-level `skills/` path remains the
canonical source for GitHub and skills.sh discovery.

## Agent Workflow

When activated, the skill instructs the agent to:

1. Inspect the host application's framework, package manager, server boundary, environment
   conventions, customer identity model, existing Unprice code, and tests.
2. Identify the paid action and read the operation-selection reference.
3. Confirm required plan, feature, event, meter, and customer identifiers instead of inventing
   product configuration.
4. Install or reuse `@unprice/api` with the host package manager.
5. Create or reuse one server-only `Unprice` client.
6. Implement the smallest integration at the request or workload boundary that owns the paid
   action.
7. Handle transport/API errors separately from commercial denial.
8. Preserve one stable idempotency key per logical mutation across retries.
9. Add focused tests and run the host project's relevant validation.

## Safety Rules

- Never expose `UNPRICE_TOKEN` or another project API key to browser code.
- Never branch application behavior on plan names; use stable feature slugs.
- Never use `usage.record` as a spend gate.
- Never begin paid work after a denied `usage.consume` or rejected run reservation.
- Always close a started run in `finally`; report `failed` after exceptions or rejected
  consumption.
- Never generate a fresh idempotency key for a retry of the same logical operation.
- Never claim exact SDK fields from memory when installed TypeScript types or the official OpenAPI
  contract are available.
- Never hide an Unprice integration failure by silently allowing paid work unless the host
  application explicitly defines that fail-open policy.

## Distribution

The public repository is the package source:

```bash
npx skills add https://github.com/jhonsfran/unprice \
  --skill integrate-unprice-sdk
```

Mintlify exposes the same files through its `/.well-known/agent-skills/` and
`/.well-known/skills/` endpoints, allowing:

```bash
npx skills add https://docs.unprice.dev
```

No `skills.sh.json` is required for one skill. Add it only when multiple Unprice skills need
catalog grouping. Before promoting the listing, normalize the repository's canonical GitHub owner
because the current Git remote and README badge use different owner names.

## Validation

Structural validation:

- Run the skill-creator `quick_validate.py` script.
- Run `npx skills add . --list` or the repository's `pnpm dlx` equivalent.
- Confirm the Mintlify symlink resolves to the canonical skill directory.

Content validation:

- Check Markdown links and reference routing.
- Compare method names against `sdkOperationIds`.
- Compare examples against generated TypeScript/OpenAPI contracts.
- Verify no secret-looking literal is included.

Forward tests:

1. Ask an agent to add a shadow access check to a backend route.
2. Ask an agent to record token usage without blocking the request.
3. Ask an agent to enforce known usage before an expensive API call.
4. Ask an agent to budget a multi-step workflow and release unused funds.
5. Ask an agent to review an intentionally unsafe client-side integration.

Successful output selects the correct operation, preserves the host architecture, keeps credentials
server-side, handles errors and denials, uses idempotency correctly, and adds proportionate tests.

## Scope Exclusions

- No MCP server or direct Unprice account operations.
- No embedded full OpenAPI snapshot or generated SDK declaration files.
- No framework-specific templates beyond small portable TypeScript patterns.
- No skills.sh catalog grouping until a second public skill exists.
- No changes to the SDK or product API.

