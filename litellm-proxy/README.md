# Cirqle LiteLLM gateway

LiteLLM is the model gateway between the Cirqle web app and the upstream model
providers. The browser makes one OpenAI-compatible request shape; LiteLLM
authenticates the user's virtual key, enforces its budget and model allowlist,
records spend, resolves the requested alias, and calls Google, DeepSeek, or
OpenAI with the provider credential stored on Railway.

The browser never receives a provider key or the LiteLLM master key.

## Request flow

```text
Firebase user signs in
  -> Vercel /api/register-user
  -> LiteLLM /key/generate, authenticated with LITELLM_MASTER_KEY
  -> per-user virtual key, $5 / 30-day budget
  -> key is stored on the user's Firestore document and in browser localStorage

AI feature
  -> src/lib/ai.ts selects fast | reasoning | draft
  -> src/lib/aiConfig.ts converts the tier to a public model alias
  -> src/lib/aiClient.ts POSTs /v1/chat/completions with the virtual key
  -> LiteLLM config.yaml resolves the alias to an upstream provider/model
  -> provider response is normalized to the OpenAI chat-completions shape
```

## Active tiers

These are the only aliases requested by the current web bundle:

| Tier | Public LiteLLM alias | Upstream model | Current jobs |
|---|---|---|---|
| `fast` | `gemini-2.5-flash-lite` | `gemini/gemini-2.5-flash-lite` | Contact parsing, CSV import, tag extraction, voice-memo summary |
| `reasoning` | `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | Weekly priorities, natural-language search, reply processing, pre-meeting brief, commitments, revival notes |
| `draft` | `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | Outreach drafts and NFC/business-card copy |

The public alias is the stable application contract. The upstream model is the
provider-specific target. They are separate so an upstream model can be changed
without editing every feature.

`config.yaml` also retains compatibility aliases for older cached clients:

| Compatibility alias | Upstream model |
|---|---|
| `gemini-flash` | `gemini/gemini-2.5-flash` |
| `gemini-3-flash-preview` | `gemini/gemini-3-flash-preview` |
| `gemini-3.1-pro-preview` | `gemini/gemini-3.1-pro-preview` |
| `gpt-5-mini` | `openai/gpt-5-mini` |
| `openai-mini` | `openai/gpt-4o-mini` |
| `openai-mini-batch` | `openai/gpt-4o-mini` |

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

### Keep the existing public alias

This is the normal and safest swap. Change only the `model:` value for that
alias in `config.yaml`, then redeploy Railway.

Example: keep the `fast` application contract but move it to a newer Gemini:

```yaml
- model_name: gemini-2.5-flash-lite
  litellm_params:
    model: gemini/<new-valid-model-id>
    api_key: "os.environ/GEMINI_API_KEY"
```

Because the alias did not change:

- feature call sites do not change;
- `src/lib/aiConfig.ts` does not change;
- existing virtual-key model allowlists do not change;
- Vercel does not need a functional frontend change.

### Introduce or rename a public alias

When the alias itself changes, keep these three places synchronized:

1. `src/lib/aiConfig.ts` — maps `fast`, `reasoning`, and `draft` to aliases.
2. `litellm-proxy/config.yaml` — maps each alias to the real provider model.
3. `api/register-user.js` — authorizes the alias on newly generated user keys.

Existing virtual keys retain the allowlist they were issued with. If a renamed
alias is not on an existing key, either retain the old alias as a compatibility
route or rotate/reissue those user keys.

## Credentials and deployment

Railway must provide:

- `LITELLM_MASTER_KEY`
- `LITELLM_SALT_KEY`
- `DATABASE_URL`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENAI_API_KEY` while OpenAI compatibility aliases remain configured

Vercel must provide the same `LITELLM_MASTER_KEY` to the serverless
`/api/register-user` function and `VITE_GATEWAY_URL` for the browser build.

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
stored key. New keys include:

- `user_id`: the Firebase UID, used for per-user aggregation;
- a readable `key_alias` beginning with `user_<firebase-uid>_`;
- metadata and the `cirqle-web` tag;
- the active and compatibility model allowlist;
- a `$5` budget that resets every `30d`.

The master key is administrative. A virtual key is restricted and safe to use
for model requests from that user's browser.

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

For new keys, filter or group by the Firebase UID stored as `user_id`. Existing
keys created before `user_id` was added can still be identified by their
`user_<firebase-uid>_...` alias. Do not expose any of these administrative
endpoints through the browser or log the master key.

## Local development

Copy `.env.template` to a local, untracked `.env`, provide development
credentials, and run:

```bash
docker compose up --build
```

The local gateway listens on `http://localhost:4000`. Keep production provider
credentials out of local files whenever possible.
