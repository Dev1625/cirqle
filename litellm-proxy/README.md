# Cirqle LiteLLM gateway

LiteLLM is the model gateway between the Cirqle web app and the upstream model
providers. The browser makes one OpenAI-compatible request shape; LiteLLM
authenticates the user's virtual key, enforces its budget and model allowlist,
records spend, resolves the requested alias, and calls Google or DeepSeek with
the provider credential stored on Railway.

The browser never receives a provider key, a LiteLLM virtual key, or the
LiteLLM master key.

## Request flow

```text
Firebase user signs in
  -> Vercel /api/register-user
  -> LiteLLM /key/generate, authenticated with LITELLM_MASTER_KEY
  -> deterministic per-user virtual key, $5 / 30-day budget
  -> key remains server-only and is never returned to the browser

AI feature
  -> grounded product call selects a semantic tier and required feature ID
  -> src/lib/aiConfig.ts supplies the browser's expected alias
  -> src/lib/aiClient.ts sends a Firebase ID token to /api/ai/chat
  -> Vercel verifies the user
  -> api/_lib/ai-feature-policy.js derives the tier, alias, and limits
  -> any client alias mismatch or excessive limit is rejected
  -> Vercel derives the server-only virtual key
  -> Vercel POSTs /v1/chat/completions to LiteLLM
  -> LiteLLM config.yaml resolves the alias to an upstream provider/model
  -> provider response is normalized to the OpenAI chat-completions shape
```

## Active tiers

These are the only aliases requested by the current web bundle:

| Tier | Public LiteLLM alias | Upstream model | Current jobs |
|---|---|---|---|
| `fast` | `gemini-3.5-flash-lite` | `gemini/gemini-3.5-flash-lite` | Contact parsing, CSV import, tag extraction, voice-memo summary, quick outreach |
| `reasoning` | `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | Weekly priorities, natural-language search, reply processing, pre-meeting brief, commitments, revival notes |
| `draft` | `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | Premium outreach improvement and NFC/business-card copy |

The semantic tier is the stable product concept. The current aliases are
provider/version-specific and must remain honest about their upstream route.
Feature call sites do not choose an upstream model; the server registry maps
their feature ID to a tier and expected alias.

`config.yaml` deliberately exposes only these three aliases. Old preview and
OpenAI compatibility aliases were removed because no current user key may
call them; keeping unused routes makes model-health checks ambiguous and
requires credentials the product does not need.

## Server feature policy

`api/_lib/ai-feature-policy.js` is the single server authority for model
selection and generation ceilings. Managed virtual-key allowlists derive from
the same registry. A browser cannot pair a cheap feature label with an
expensive alias, omit attribution, or raise a feature's output/temperature
limit.

| Feature ID | Tier | Max output tokens | Max temperature |
|---|---:|---:|---:|
| `dashboard-weekly-priorities` | reasoning | 500 | 0.4 |
| `global-natural-language-search` | reasoning | 800 | 0.4 |
| `pre-meeting-brief` | reasoning | 700 | 0.4 |
| `dormant-revival-draft` | reasoning | 450 | 0.4 |
| `commitment-extraction` | reasoning | 900 | 0.4 |
| `digital-card-draft` | draft | 450 | 0.4 |
| `voice-memo-summary` | fast | 120 | 0.4 |
| `directory-csv-import` | fast | 3,200 | 0.4 |
| `directory-contact-parse` | fast | 700 | 0.4 |
| `contact.reply.process` | reasoning | 350 | 0.1 |
| `contact.tags.extract` | fast | 700 | 0 |
| `contact.outreach.draft.quick` | fast | 550 | 0.2 |
| `contact.outreach.draft.premium` | draft | 900 | 0.2 |
| `production-signup-smoke` | fast | 8 | 0 |

The smoke policy additionally accepts only the exact `Reply with only OK.`
prompt and disallows JSON mode. It is a deployment check, not a general model
surface.

## Why `config.yaml` matters

`config.yaml` is the runtime routing table loaded by the LiteLLM container on
Railway. For every `model_list` entry:

- `model_name` is the public alias accepted from the app.
- `litellm_params.model` is the real `provider/model` target.
- `litellm_params.api_key` names the Railway environment variable containing
  the provider credential.

A healthy LiteLLM process does not prove every upstream target is valid.
`/health/liveliness` can return 200 while a retired model produces a provider
404. After every model change, make one real completion through each active
alias.

## Changing a model

### Change only an upstream deployment

Keep an existing public alias only when the provider route remains the same
advertised model identity, such as a compatible deployment or regional route.
Change the `model:` value in `config.yaml`, redeploy Railway, and smoke-test
the alias.

Example:

```yaml
- model_name: gemini-3.5-flash-lite
  litellm_params:
    model: gemini/gemini-3.5-flash-lite
    api_key: "os.environ/GEMINI_API_KEY"
```

Do not leave a `gemini-3.5-flash-lite` alias pointing at a materially different
model. That makes health checks, spend reports, and incident diagnosis
misleading.

### Replace a provider/model

When a tier moves to a different model identity, introduce an honest alias and
keep these three places synchronized:

1. `api/_lib/ai-feature-policy.js` — authoritative server tier and feature
   policy; managed virtual-key allowlists derive from it.
2. `src/lib/aiConfig.ts` — browser-side expected tier aliases.
3. `litellm-proxy/config.yaml` — alias-to-provider route.

Redeploy Vercel and Railway together. Existing managed identities are
reconciled during sign-in; verify the live key allowlist after the release.
Retain the old alias temporarily only when an intentional compatibility window
is required.

There are intentionally no `VITE_AI_MODEL_*` overrides. A browser-only
deployment override could drift away from the gateway and virtual-key policy.
The release configuration test fails when the three code-owned contracts do
not match.

## Credentials and deployment

Railway must provide:

- `LITELLM_MASTER_KEY`
- `LITELLM_SALT_KEY`
- `DATABASE_URL`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`

Vercel must provide `LITELLM_MASTER_KEY`, a stable
`LITELLM_KEY_DERIVATION_SECRET`, and the server-only `LITELLM_GATEWAY_URL` to
the provisioning, AI proxy, usage, and account-lifecycle functions. Vercel
also needs Firebase Admin credentials as documented in the root environment
template.

The derivation secret must be independently generated and different from the
master key. Every preview and production environment must set its gateway URL
explicitly. Server code has no hard-coded production URL, `VITE_GATEWAY_URL`
compatibility path, or master-key derivation fallback; incomplete
configuration fails closed. Vercel environments also require distributed
Upstash/KV throttling. Provisioning consumes independent hashed UID and trusted
edge-IP buckets, and successful authenticated provisioning blindly removes
legacy raw AI-key fields from the private root user document.

Never put provider keys or `LITELLM_MASTER_KEY` in a `VITE_*` variable. Vite
inlines those values into public browser JavaScript.

Railway builds this directory with `Dockerfile` and starts LiteLLM with:

```text
litellm --config /app/config.yaml
```

After a Railway deployment:

1. Check `GET /health/liveliness`.
2. Authenticate with the master key and inspect `GET /model/info`.
3. Make a tiny `/v1/chat/completions` request through each active alias.
4. Confirm the request appears in the LiteLLM Usage view or spend logs.

## Virtual keys and budgets

Vercel's `api/register-user.js` creates one virtual key when an account has no
managed key and reconciles the same identity on every later sign-in. New keys
include:

- `user_id`: the Firebase UID, used for per-user aggregation;
- a deterministic, non-secret alias derived from the Firebase UID;
- metadata linking the key to its Firebase identity;
- only the three active model aliases;
- a `$5` budget that resets every `30d`.

The master key is administrative. A virtual key is restricted, but it is still
a spend-enabled credential and therefore remains on the server. Browser
requests carry short-lived Firebase authentication instead.

## Private relationship-data handling

`config.yaml` intentionally keeps spend/request metadata while disabling
response caching, raw request/response logging, prompt storage in spend logs,
verbose model logging, and LiteLLM telemetry. The Settings usage surface reads
sanitized aggregates through `/api/ai/usage`; it never exposes prompts,
responses, virtual keys, or the master key.

After every LiteLLM version upgrade, verify these privacy settings against the
running version before sending production relationship data:

- `cache: false`
- `turn_off_message_logging: true`
- `log_raw_request_response: false`
- `store_prompts_in_spend_logs: false`
- `set_verbose: false`

## Viewing spend

The deployed proxy exposes its admin UI at:

```text
https://litellm-production-2a63.up.railway.app/ui
```

Authenticate as the proxy administrator with the master-key credentials. The
Usage view is the easiest place to inspect total cost, cost by model, request
volume, and individual keys/users.

The running LiteLLM version also exposes these master-key-authenticated APIs:

| Need | Endpoint |
|---|---|
| List keys and their accumulated spend | `GET /key/list?return_full_object=true&sort_by=spend&sort_order=desc` |
| Inspect one key | `GET /key/info?key=<key-or-hash>` |
| Filter calls directly by Firebase UID | `GET /spend/logs?user_id=<firebase-uid>&start_date=<YYYY-MM-DD>&end_date=<YYYY-MM-DD>` |
| Filter/paginate detailed calls by model or key alias | `GET /spend/logs/v2?key_alias=<alias>` |
| Aggregate total spend over a date range | `GET /global/spend/report` |
| Inspect the loaded alias-to-provider map | `GET /model/info` |

Example admin request:

```bash
curl \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  "https://litellm-production-2a63.up.railway.app/key/list?return_full_object=true&sort_by=spend&sort_order=desc"
```

Per-user request:

```bash
curl \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  "https://litellm-production-2a63.up.railway.app/spend/logs?user_id=<firebase-uid>&start_date=2026-07-01&end_date=2026-07-31&summarize=true"
```

For managed keys, filter or group by the Firebase UID stored as `user_id`.
Existing legacy keys must be ownership-verified before migration or deletion.
Do not expose any of these administrative endpoints through the browser or log
the master key.

## Local development

Copy `.env.template` to a local, untracked `.env`, provide development
credentials, and run:

```bash
docker compose up --build
```

The local gateway listens on `http://localhost:4000`. Keep production provider
credentials out of local files whenever possible.
