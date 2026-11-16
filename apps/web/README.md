# Coppify SaaS web

This Next.js application is the first SaaS workspace. The existing local-first
Flask application remains available while the new platform is built in staged
releases.

## Local setup

1. Install the root npm workspace dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, S3-compatible storage
   credentials, and `AUTH_SECRET`.
3. Configure one or more sign-in methods below. For Google, register this
   redirect URI with the OAuth client:
   `http://localhost:9911/api/auth/callback/google`.
4. Generate the Prisma client with `npm run db:generate`.
5. Apply the schema to a development PostgreSQL database with `npm run db:migrate`.
6. Start the app from the repository root with
   `npm run dev --workspace @coppify/web -- --port 9911`.

Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
Do not commit `.env` or provider credentials.

## Environment

- `DATABASE_URL`: PostgreSQL connection string used by the app and Prisma CLI.
- `DATABASE_POOL_MAX`: per-process PostgreSQL pool size, from 1 to 50 (default 10).
- `REDIS_URL`: BullMQ connection; production URLs must use `rediss://`.
- `S3_BUCKET`, `S3_REGION`, and optional `S3_ENDPOINT`: private S3-compatible
  object storage. For production, a custom endpoint must use HTTPS.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: optional as a pair; omit both
  when the runtime provides credentials through its identity chain.
- `S3_FORCE_PATH_STYLE`: use `true` for compatible local stores such as MinIO.
- `S3_UPLOAD_URL_TTL_SECONDS` and `S3_DOWNLOAD_URL_TTL_SECONDS`: signed URL
  lifetime, limited to 60–900 seconds.
- `MAX_UPLOAD_BYTES`: maximum source video size (default 1 GiB; maximum 5 GB).
- `AUTH_SECRET`: random secret of at least 32 bytes.
- `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`: set both to enable Google sign-in.
- `AUTH_RESEND_KEY`: Resend API key for passwordless email sign-in.
- `AUTH_EMAIL_FROM`: the verified sender address used for passwordless sign-in
  links. Set it with `AUTH_RESEND_KEY` to enable email sign-in. Verify the
  sending domain in Resend before using a custom sender address.
- `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`: set all
  three to enable the optional organization OIDC sign-in provider. For the
  current Entra application, its tenant-specific issuer keeps this method limited
  to that tenant; Google and email sign-in are separate options for general
  creator access.
- `AUTH_OIDC_NAME`: optional display name for the configured identity provider.
- `AUTH_URL`: public app origin used for authentication callbacks. Use
  `http://localhost:9911` for the current local preview, and set it to the
  HTTPS production origin when deployed.

Never put provider secrets in `.env.example` or commit them. Keep local values in
`.env` and production values in the deployment platform's secret store. Email
magic links require a configured Resend sender and a PostgreSQL database for
verification tokens and sessions.

The initial data model scopes projects, media, jobs, transcripts, clips,
exports, and usage events to a workspace. API handlers derive the user from the
Auth.js session; clients cannot choose an acting user.

Uploads use short-lived presigned POST forms. The API checks workspace
membership, allowed video MIME types, declared size, and the stored object's
actual size and content type before marking an asset ready. Keep the bucket
private and configure its CORS rules for the SaaS web origin.

Ready assets can be enqueued through the authenticated project asset jobs API
with an `Idempotency-Key` header. Job state and bounded event history are
persisted in PostgreSQL; BullMQ retains bounded Redis job history. The queue
producer/status API is in place, but the private Python worker is still under
development, so do not treat queued jobs as processed yet.
