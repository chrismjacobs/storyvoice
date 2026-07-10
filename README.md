# Storyvoice

Bring voice to stories. See `CLAUDE.md` for the full spec.

## Local setup

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

flask db init
flask db migrate -m "initial schema"
flask db upgrade

flask seed-admin   # creates the admin user from ADMIN_EMAIL / ADMIN_PASSWORD in .env

flask run
```

Requires a `.env` with `SECRET_KEY`, `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_S3_BUCKET`, `AWS_S3_REGION`, and optionally `S3_PREFIX` / `PRESIGN_TTL_SECONDS`.

## Deploy

Docker image installs system `ffmpeg` (see `Dockerfile`) and runs `gunicorn app:app`.
Use separate Render services for `production` and `staging`, each with its own `DATABASE_URL`
and `S3_PREFIX` so media never crosses environments.
