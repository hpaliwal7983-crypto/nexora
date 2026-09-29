# Nexora

Nexora is a role-based learning workspace for trainees, trainers, and administrators. It serves the browser application and its authenticated API from one Node.js service.

## Backend

- PostgreSQL stores accounts, hashed passwords, revocable sessions, shared workspace content, and each learner's progress.
- Trainee registrations become active immediately. Trainer registrations wait for an administrator to approve them. Admin accounts are provisioned by the workspace owner.
- A public, low-privilege Harsh demo account is available on the sign-in page for walkthroughs; demo visitors share its sample learning progress.
- The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` on initial startup. Use a unique password with at least 12 characters. Later administrators can be created from the Admin workspace.
- Trainees start with an empty personal learning record, then enroll in a course, complete its modules, and take its server-scored assessment. Scores of 70% or more issue a saved course certificate.
- Trainers can publish owned courses, upload course resources, assign deadline-based questionnaires, and review trainee skill evidence. Trainees can submit responses before deadlines and send feedback after completing a course.
- Admin analytics and approval lists are calculated from saved account and learning records.
- Role checks run in the API. Passwords are scrypt-hashed and sessions use secure, HTTP-only cookies in production.

The Co-pilot remains deterministic guidance based on the learner's saved competencies. Google/Microsoft sign-in, password reset email, hosted file uploads, and a hosted AI model require separate provider configuration and are not enabled by this backend.

## Local run

Use Node.js 20 or newer and a PostgreSQL database. Set `DATABASE_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the process environment, then run:

```powershell
npm ci
npm start
```

Open `http://localhost:4173`. The schema is applied automatically when the server starts.

## Render

`render.yaml` defines the Nexora web service and its PostgreSQL database. The first Blueprint setup prompts for `ADMIN_EMAIL` and `ADMIN_PASSWORD`; keep these values private. The database uses Render's free plan for the requested 30-day test. Free databases expire 30 days after creation; upgrade to a paid plan before expiry to keep the database and its data. Do not use this free database for production data that must be retained.

The health endpoint is `/api/health`. Render should receive `DATABASE_URL` from the database's internal connection string.
