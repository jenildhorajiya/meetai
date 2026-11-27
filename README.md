# MeetAI

MeetAI runs AI-assisted video meetings with Stream Video and OpenAI Realtime. After each meeting, Inngest processes the transcript and the meeting owner can review the recording, summary, and chat.

## Local development

Use Node.js 22.12 or newer. Run `npm ci`, supply the variables below in a gitignored `.env`, then run `npm run dev`. To initialize a new development database, run `npm run db:push` against that database.

Run `npm run lint` and `npm run build` to check changes.

## Environment variables

| Service | Variables |
| --- | --- |
| Neon PostgreSQL | `DATABASE_URL` |
| Better Auth | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` |
| Stream Video | `NEXT_PUBLIC_STREAM_VIDEO_API_KEY`, `STREAM_VIDEO_SECRET_KEY` |
| Stream Chat | `NEXT_PUBLIC_STREAM_CHAT_API_KEY`, `STREAM_CHAT_SECRET_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Inngest | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` for hosted Inngest |
| Polar Sandbox | `POLAR_ACCESS_TOKEN` |
| Social sign-in | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

Set `BETTER_AUTH_URL` to the origin receiving sign-in requests. Configure provider callbacks at that origin under `/api/auth/callback/github` and `/api/auth/callback/google`.

## Vercel preview

Configure the Preview environment with test service credentials and deploy the PR branch. Configure Stream Video and Chat webhook delivery to `/api/webhook` and sync Inngest with `/api/inngest` on the preview host. Both services need to reach their endpoints if deployment protection is enabled. Use test service integrations for preview so their callbacks and test data stay separate from production.

Sign in, create an agent and meeting, and confirm two-way audio. End the meeting as its owner and verify the transcript, recording, summary, and follow-up chat.
