# Orefyspace AI

Orefyspace AI is a personal AI workspace with a clean ChatGPT-inspired interface, account sign-in, and a configurable multi-provider gateway. It includes persistent conversations, projects, a reusable prompt library, live model discovery, per-conversation model selection, provider-aware streaming chat responses, export, archive, search, and explicit provider/quota errors.

## Current implementation

The app uses a small Node server and a dependency-free browser frontend, so it runs without a build step. Supabase Auth handles email/password and Google, Apple, and Microsoft sign-in; the server verifies access tokens and keeps each account's conversations, projects, and prompts separate. The server remains the boundary for model-provider API keys.

The official uploaded logo was not available as a workspace file at build time. The UI references `/orefyspace-logo.png` directly and falls back to an accessible text wordmark only until that official asset is placed in `public/`.

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. Set `OPENROUTER_API_KEY` in `.env` to enable live model responses.
4. For account sign-in, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as described below; leave them empty to run the existing single-user local mode.
5. Optionally set `OPENROUTER_MODEL` to your preferred default model.
6. Put the official Orefyspace logo at `public/orefyspace-logo.png`.
7. Start the app:

```bash
npm start
```

Open `http://localhost:3000`.

For development with automatic server restarts:

```bash
npm run dev
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | For live mode | Server-only OpenRouter API key. Never sent to the browser. |
| `OPENROUTER_MODEL` | No | Default OpenRouter model used when a provider prefix is omitted. The zero-cost starter value is `openrouter/free`; verify current availability and terms before deployment. |
| `OPENROUTER_SITE_URL` | No | Referer sent to OpenRouter for attribution. |
| `OPENROUTER_APP_NAME` | No | Application title sent to OpenRouter for attribution. |
| `GEMINI_API_KEY` | No | Backend-only Google Gemini API key. |
| `GROQ_API_KEY` | No | Backend-only Groq API key. |
| `CLOUDFLARE_API_TOKEN` | No | Backend-only Cloudflare API token with Workers AI permission. |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account ID for Workers AI. |
| `CLOUDFLARE_WORKERS_AI_MODELS` | No | Optional JSON array to replace the small default Workers AI model list. |
| `PROVIDER_FALLBACK_CHAIN` | No | Comma-separated provider/model keys used only when the requested provider fails, for example `groq:openai/gpt-oss-20b,openrouter:openrouter/free`. Fallback is explicit in the streamed metadata. |
| `DATABASE_URL` | No locally; recommended in deployment | PostgreSQL connection string. When present, the server uses durable PostgreSQL state instead of ephemeral local files. |
| `DATABASE_SSL` | No | Set to `true` for hosted PostgreSQL connections. |
| `SUPABASE_URL` | Required for auth | Supabase project URL, for example `https://<project-ref>.supabase.co`. |
| `SUPABASE_ANON_KEY` | Required for auth | Supabase public anon/publishable key. Never use the `service_role` key in the browser or here. |
| `AUTH_REQUIRED` | No; set `true` in production | Fail closed if Supabase Auth is not configured. When Supabase URL and key are present, API routes require a valid signed-in user. |
| `OPENROUTER_TIMEOUT_MS` | No | Upstream timeout in milliseconds, defaults to `45000`. |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | No | Server-side output cap, defaults to `4096`. |
| `MAX_REQUEST_BYTES` | No | JSON request body limit, defaults to `1000000`. |
| `MAX_MESSAGES` | No | Maximum conversation turns accepted by `/api/chat`, defaults to `50`. |
| `MAX_MESSAGE_CHARS` | No | Maximum characters in one message, defaults to `20000`. |
| `MAX_CONVERSATION_CHARS` | No | Maximum combined message characters, defaults to `100000`. |
| `CHAT_RATE_WINDOW_MS` | No | In-memory chat rate-limit window, defaults to `600000`. |
| `CHAT_RATE_LIMIT` | No | Maximum chat requests per client per window, defaults to `30`. |
| `PORT` | No | Local HTTP port, defaults to `3000`. |

## Account sign-in setup

Create a Supabase project, then set `SUPABASE_URL` and its public anon/publishable key as `SUPABASE_ANON_KEY`. Set `AUTH_REQUIRED=true` on production deployments. The app supports email/password and uses Supabase Auth for Google, Apple, and Microsoft; the server checks every authenticated API request against Supabase and stores workspace data per user. Do not add a Supabase `service_role` key to this app.

In Supabase, set the project **Site URL** and allowed redirect URLs to the deployed app origin and your local development origin (for example `http://localhost:3000`). Enable email/password sign-up and choose whether new accounts need email confirmation. Then enable [Google](https://supabase.com/docs/guides/auth/social-login/auth-google), [Apple](https://supabase.com/docs/guides/auth/social-login/auth-apple), and [Azure (Microsoft)](https://supabase.com/docs/guides/auth/social-login/auth-azure) under Authentication → Providers and enter each provider's client credentials in Supabase. The identity-provider callback URL is the Supabase Auth callback shown in the provider settings, typically `https://<project-ref>.supabase.co/auth/v1/callback`; the app returns to its own allowed Site URL after authentication. Microsoft sign-in requests the `email` scope.

Google, Apple, and Microsoft sign-in will not complete until the corresponding provider apps and credentials are configured in Supabase. Apple web sign-in requires an Apple Developer account and its signing key must be rotated every six months. When auth is enabled, new accounts start with a separate workspace; the old shared local/default workspace is deliberately not assigned to the first account, to avoid exposing existing data to whichever user signs up first.

## Production deployment

- Run behind HTTPS and a reverse proxy such as Nginx, Caddy, or a platform-managed edge proxy.
- Set environment variables in the host's secret manager, not in the repository.
- Use `DATABASE_URL` with PostgreSQL/Supabase for deployment persistence. Local JSON storage is only a fallback for local development and ephemeral environments.
- Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `AUTH_REQUIRED=true` before exposing the server publicly. Keep the auth provider secrets in Supabase, not in this repository.
- Use `DATABASE_URL` for durable per-user workspace storage; local per-user JSON files are suitable only for development and are ephemeral on many hosts.
- Keep `OPENROUTER_API_KEY` server-side. Workspace API routes require a Supabase access token when auth is enabled; browser sign-in requests go directly to Supabase Auth.

## API surface

- `GET /api/health` — reports live/demo mode and default model.
- `GET /api/auth/config` — returns whether auth is enabled and the public Supabase project URL/key needed by the browser.
- `GET /api/models` — retrieves provider catalogues server-side and returns normalized models with provider, capabilities, pricing/free-status notes, and configuration state. OpenRouter, Groq, and Gemini are queried dynamically; Workers AI is configurable through `CLOUDFLARE_WORKERS_AI_MODELS` because its model list is account/catalogue dependent.
- `GET /api/conversations` — loads active saved conversations. Supports `?archived=true` and `?projectId=...`.
- `POST /api/conversations` — creates or upserts a conversation.
- `PATCH /api/conversations/:id` — renames or updates a conversation.
- `DELETE /api/conversations/:id` — deletes a conversation.
- `GET /api/conversations/:id/export` — downloads a Markdown export.
- `GET /api/projects` — lists projects.
- `POST /api/projects` — creates a project.
- `PATCH /api/projects/:id` — updates a project.
- `DELETE /api/projects/:id` — deletes a project and unassigns its conversations.
- `GET /api/prompts` — lists saved prompts, including seeded coding, research, writing, and automation examples.
- `POST /api/prompts` — creates a saved prompt.
- `PATCH /api/prompts/:id` — edits a saved prompt.
- `DELETE /api/prompts/:id` — deletes a saved prompt.
- `POST /api/chat` — validates `{ model, messages }`, routes by provider key such as `openrouter:...`, `groq:...`, `gemini:...`, or `cloudflare:...`, adds the server-side output limit, and returns a normalized SSE stream.

All workspace routes except `/api/health` and `/api/auth/config` require a valid Supabase access token whenever `SUPABASE_URL` and `SUPABASE_ANON_KEY` are configured.

### Chat request shape

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are Orefyspace AI." },
    { "role": "user", "content": "Help me plan this project." },
    { "role": "assistant", "content": "Sure — what are you building?" },
    { "role": "user", "content": "A personal AI workspace." }
  ]
}
```

The server accepts only `system`, `user`, and `assistant` roles with non-empty text content. It limits request size, message count, per-message size, total conversation size, and provider/model key length. The frontend sends previous turns from the active conversation so the selected model receives the relevant context. Model keys are persisted on conversations so the app does not silently change providers between turns.

### Error responses

Errors use a stable JSON shape:

```json
{
  "error": "OpenRouter rate-limited this request. Wait a moment and try again.",
  "code": "rate_limited"
}
```

The server maps common upstream failures to actionable codes including `openrouter_auth`, `invalid_model`, `rate_limited`, `insufficient_credits`, `provider_failure`, `upstream_timeout`, `network_error`, and `server_error`. Provider details are redacted and truncated before they reach the browser.

### Streaming and cancellation

`/api/chat` uses provider-specific adapters. OpenRouter and Groq use OpenAI-compatible streaming; Gemini uses `streamGenerateContent`; Cloudflare Workers AI uses its JSON inference route and is normalized into the same SSE shape. Aborting the browser request aborts the upstream request as well. Optional fallback candidates are only used when configured and the stream metadata tells the user which provider was selected after fallback.

## Demo mode and limitations

When no provider key is configured, the app visibly labels itself **Demo mode**, does not fabricate live model availability, and rejects chat requests with a provider configuration error instead of pretending the model responded. Add a backend key and restart the server for live responses.

Known limitations for this first production-oriented slice:

- Without Supabase Auth configuration, the app remains in its legacy single-workspace local mode. With auth enabled, accounts are isolated, but local per-user JSON storage is not durable across ephemeral hosting restarts.
- Billing, per-user quotas, audit logging, and distributed rate limiting are not included. The chat limiter is in-memory and resets when the server restarts; it is not a substitute for a distributed rate limiter.
- Attachments currently add the selected filenames to the composer; file extraction and multimodal payloads still need a storage and security policy.
- Rename/delete uses a small prompt interaction rather than a full context menu.
- The JSON conversation store is suitable for local development only; use PostgreSQL (`DATABASE_URL`) for durable multi-user production use.
- Authentication is provided by Supabase Auth. Social sign-in depends on configuring each provider in the Supabase dashboard and registering the Supabase callback URL with that provider.

For production, configure each enabled identity provider in Supabase, set `AUTH_REQUIRED=true`, and use PostgreSQL for durable account workspaces. Durable rate limiting, audit logging, and backup policies remain deployment responsibilities.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the inspected architecture, recommended Render + Supabase zero-cost starting deployment, exact environment variable names, health-check verification, logs, hosting limits, OpenRouter cost caveats, and alternative hosting paths.
