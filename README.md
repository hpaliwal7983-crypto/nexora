# Nexora

Nexora is a role-based learning workspace for trainees, trainers, and administrators. It serves the browser application and its authenticated API from one Node.js service.

## Backend

- PostgreSQL stores accounts, hashed passwords, revocable sessions, shared workspace content, and each learner's progress.
- Trainee, Trainer, and Admin registrations use the same name, email, Employee ID, password, and confirmation form. Trainees activate immediately; Trainer and Admin accounts wait for administrator approval. Profile details are saved after registration. Email or Employee ID can be used to sign in.
- The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on initial startup. Use a unique password with at least 12 characters. Later administrators can be created from the Admin workspace.
- Trainees start with an empty personal learning record, then enroll in a course, complete its modules, and take its server-scored assessment. Scores of 70% or more issue a saved course certificate.
- Trainers can publish owned courses, upload course resources, assign deadline-based questionnaires, and review trainee skill evidence. Trainees can submit responses before deadlines and send feedback after completing a course.
- Admin analytics and approval lists are calculated from saved account and learning records.
- Role checks run in the API. Passwords are scrypt-hashed and sessions use secure, HTTP-only cookies in production.

Nexora AI is built into the existing workspace as a role-aware side panel. Navigation is handled locally; factual answers use the authenticated account's saved data; open-ended reasoning is sent only from the backend through a configurable OpenAI-compatible provider. The provider key is never included in browser code. Voice input uses browser speech recognition and spoken replies use browser speech synthesis where supported; text remains available without either capability.

## Local run

Use Node.js 20 or newer and a PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the process environment. Nexora AI's deterministic navigation and database answers work without an AI key. To enable open-ended reasoning, choose one provider and set its server-only key plus model (`AI_PROVIDER` and `AI_MODEL`). The current provider adapter supports `openrouter` and `openai`; unused provider credentials are not required. Then run:

```powershell
npm ci
npm start
```

Open `http://localhost:4173`. The schema is applied automatically when the server starts.

## Render

`render.yaml` defines the Nexora web service and its PostgreSQL database. The first Blueprint setup prompts for `ADMIN_EMAIL` and `ADMIN_PASSWORD`; keep these values private. The database uses Render's free plan for the requested 30-day test. Free databases expire 30 days after creation; upgrade to a paid plan before expiry to keep the database and its data. Do not use this free database for production data that must be retained.

The health endpoint is `/api/health`. Render should receive `DATABASE_URL` from the database's internal connection string. Add the selected AI provider key and model in the Render service's private environment settings when you are ready to enable live reasoning. Never add provider keys to source files or commit them.
