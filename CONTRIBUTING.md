# Contributing to caliche-cards

## Running locally with Docker

You'll need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows) or Docker Engine + Compose on Linux.

```bash
git clone https://github.com/<your-username>/caliche-cards.git
cd caliche-cards
cp .env.example .env.local  # required before docker compose up
```

Open `.env.local` and set `AUTH_SECRET` to a random string:

```bash
openssl rand -base64 32
```

Then start the stack:

```bash
docker compose up
```

First run pulls images and builds the app, takes a couple of minutes. After that it's fast. Open [http://localhost:3000](http://localhost:3000) when you see `✓ Ready`.

Hot reload works out of the box. Edit a file, browser updates.

To stop:

```bash
docker compose down      # keeps your data
docker compose down -v   # wipes the database too
```

---

## Troubleshooting

**Port 3000 already in use**

Something else is on port 3000. Either stop it or change the port mapping in `docker-compose.yml`:

```yaml
ports:
  - "3001:3000"
```

Then open [http://localhost:3001](http://localhost:3001) instead.

---

## Running without Docker

See [README.md](README.md#getting-started). You'll need your own MongoDB instance (local or Atlas free tier works).

---

## Making a change

Branch off `master`, make your change, run `npm run lint`, open a PR. That's it.

---

## Environment variables

See `.env.example`, every variable is documented there.
