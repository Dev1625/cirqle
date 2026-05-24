# 🌐 Cirqle LiteLLM API Proxy Gateway

This repository contains the lightweight, production-ready, Dockerized **LiteLLM API Proxy** designed for **Cirqle**. 

It enables administrators to generate unique, trackable, and capped virtual API keys for individual application users to route Google Gemini and OpenAI requests. Additionally, it natively supports OpenAI's Batch Processing endpoints (`/v1/files` and `/v1/batches`) to leverage **50% cost discounts** while tracking usage.

---

## 🏗️ Architecture Overview

The gateway utilizes exactly **two services** via Docker Compose:
1. `litellm-proxy`: The gateway core mapping standard routes, storing persistent state (keys, logs, budgets) inside a container-mounted SQLite database file (`/data/litellm.db`).
2. `redis`: Core state cache for high-speed rate-limiting verification, distributed caching, and real-time synchronization of dollar budgets.

```
                    ┌────────────────────────┐
                    │  Cirqle Frontend App   │
                    └───────────┬────────────┘
                                │ (Virtual API Key)
                                ▼
                    ┌────────────────────────┐
                    │ LiteLLM Proxy (:4000)  │
                    └────┬──────────────┬────┘
                         │              │
        (Budgets/Cache)  ▼              ▼  (Persistent Keys/Logs)
                    ┌─────────┐    ┌─────────┐
                    │  Redis  │    │ SQLite  │
                    └─────────┘    └─────────┘
```

---

## 🚀 Getting Started

### 1. Security & Environment Setup
Copy the template environment file and populate your actual API keys:
```bash
cp .env.template .env
```

Open `.env` and fill in:
* `LITELLM_MASTER_KEY`: Set your master administrative token (must start with `sk-`, e.g., `sk-cirqle-admin-master-key-1234`).
* `LITELLM_SALT_KEY`: Set a long random string to encrypt the keys in the SQLite database.
* `OPENAI_API_KEY`: Your OpenAI organization key.
* `GEMINI_API_KEY`: Your Google Gemini Developer API key.

### 2. Launch the Services
Start the Docker containers in detached mode:
```bash
docker compose up -d --build
```

Verify that both services are healthy:
```bash
docker compose ps
```

---

## 🛠️ Admin Runbook (User Lifecycle & Key Management)

All admin endpoints must be authenticated using the `LITELLM_MASTER_KEY` defined in your `.env`.

### 1. Generate a Capped & Restricted Virtual Key
Generate a trackable virtual key for an individual user. This key is constrained to:
* **Max Dollar Budget**: Capped at `$5.00` total lifetime spend.
* **Rate Limit**: Capped at `20` requests per minute (RPM).
* **Restricted Access**: Only allowed to invoke the `gemini-flash`, `openai-mini`, and `openai-mini-batch` models.

```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "user-cirqle-crm-001",
    "max_budget": 5.00,
    "rpm_limit": 20,
    "models": ["gemini-flash", "openai-mini", "openai-mini-batch"]
  }'
```

**Expected Response**:
```json
{
  "key": "sk-1234...xxxx",
  "expires": null,
  "key_alias": "user-cirqle-crm-001",
  "max_budget": 5.0,
  "rpm_limit": 20,
  "models": ["gemini-flash", "openai-mini", "openai-mini-batch"]
}
```
> ⚠️ **Save the returned `key`!** This is the virtual key your client application will use to authenticate.

---

## 🧪 Client Validation (Standard & Batch Endpoints)

Clients authenticate by passing their virtual key in the `Authorization: Bearer <VIRTUAL_KEY>` header.

### 1. Synchronous Chat Completion (Google Gemini Flash)
Send a synchronous request to the `gemini-flash` model via the gateway:

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <VIRTUAL_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash",
    "messages": [
      {
        "role": "user",
        "content": "Hello! Confirm you are routing through Cirqle Proxy."
      }
    ]
  }'
```

---

### 2. Asynchronous OpenAI Batch Processing (50% Cost Discount)
OpenAI's Batch API requires uploading a `.jsonl` requests file, submitting a batch job referencing the file, and then querying its status. The proxy natively tracks token usage and associates costs with the user's virtual key.

#### Step A: Prepare the Batch Payload File (`requests.jsonl`)
Create a file named `requests.jsonl` containing the chat requests:
```json
{"custom_id": "request-1", "method": "POST", "url": "/v1/chat/completions", "body": {"model": "openai-mini-batch", "messages": [{"role": "user", "content": "Analyze: 2+2"}], "max_tokens": 50}}
{"custom_id": "request-2", "method": "POST", "url": "/v1/chat/completions", "body": {"model": "openai-mini-batch", "messages": [{"role": "user", "content": "Analyze: 3+3"}], "max_tokens": 50}}
```

#### Step B: Upload Payload File to Proxy
Upload the payload file using the `/v1/files` endpoint. Specify `model=openai-mini-batch` as a form-data parameter to route it correctly:

```bash
curl -X POST http://localhost:4000/v1/files \
  -H "Authorization: Bearer <VIRTUAL_KEY>" \
  -F "purpose=batch" \
  -F "file=@requests.jsonl" \
  -F "model=openai-mini-batch"
```

**Expected Response**:
```json
{
  "id": "file-encoded-xxxxxx",
  "object": "file",
  "bytes": 352,
  "created_at": 1716487800,
  "filename": "requests.jsonl",
  "purpose": "batch"
}
```
> ℹ️ LiteLLM automatically encodes the routing information directly into the returned `id` (e.g. `file-encoded-xxxxxx`).

#### Step C: Dispatch the Batch Job
Submit the batch job using the returned file ID:

```bash
curl -X POST http://localhost:4000/v1/batches \
  -H "Authorization: Bearer <VIRTUAL_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "input_file_id": "<FILE_ID_FROM_STEP_B>",
    "endpoint": "/v1/chat/completions",
    "completion_window": "24h"
  }'
```

**Expected Response**:
```json
{
  "id": "batch-encoded-yyyyyy",
  "object": "batch",
  "endpoint": "/v1/chat/completions",
  "errors": null,
  "input_file_id": "file-encoded-xxxxxx",
  "completion_window": "24h",
  "status": "validating",
  "output_file_id": null,
  "error_file_id": null,
  "created_at": 1716487850,
  "in_progress_at": null,
  "expires_at": null,
  "finalizing_at": null,
  "completed_at": null,
  "failed_at": null,
  "expired_at": null,
  "cancelled_at": null,
  "request_counts": {
    "total": 2,
    "completed": 0,
    "failed": 0
  },
  "metadata": null
}
```

#### Step D: Monitor Batch Status
Retrieve the current batch processing status using the returned Batch ID:

```bash
curl -X GET http://localhost:4000/v1/batches/<BATCH_ID_FROM_STEP_C> \
  -H "Authorization: Bearer <VIRTUAL_KEY>"
```

Once the status is `"completed"`, the `output_file_id` will be populated, and you can download the final output using:
```bash
curl -X GET http://localhost:4000/v1/files/<OUTPUT_FILE_ID>/content \
  -H "Authorization: Bearer <VIRTUAL_KEY>"
```

---

## 🔌 Frontend Client Integration Guide

To swap the direct API endpoints over to the proxy target, update your initialization code inside [gemini.ts](file:///c:/Users/Devarshi%20Dalal/Documents/Projects/official%20cirqle%20crm/src/lib/gemini.ts):

```typescript
import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | null = null;

export function getGemini(userApiKey?: string): GoogleGenAI {
  // 1. Ingest dynamic user API key (virtual key), fallback to localStorage
  const apiKey = userApiKey || 
                 (typeof window !== "undefined" ? localStorage.getItem("CIRQLE_USER_PROXY_KEY") : null) || 
                 process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("API Key is not defined.");
  }

  // 2. Change the baseURL to target the LiteLLM proxy
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

  // 3. Re-initialize client if key changes
  if (!aiClient || lastApiKey !== apiKey) {
    aiClient = new GoogleGenAI({ 
      apiKey: apiKey,
      httpOptions: {
        baseUrl: gatewayUrl
      }
    });
    lastApiKey = apiKey;
  }

  return aiClient;
}
```

### Transition Steps:
1. Generate the virtual key for a user using the Admin endpoint.
2. Save this key in your client browser session (e.g., `localStorage.setItem('CIRQLE_USER_PROXY_KEY', 'sk-...')`).
3. Call `getGemini()` in your UI hooks. The SDK will automatically route all subsequent requests (such as `ai.models.generateContent`) to `http://localhost:4000` using the user's capped key!
