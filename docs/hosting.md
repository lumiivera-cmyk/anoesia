# Running Anoesia on the Amaedori server

Anoesia runs beside Amaedori as its own service: same server, same Caddy,
its own folder, port (4950), database and password. Updating or restarting
one doesn't touch the other.

These steps assume Amaedori is already set up with its installer
(Amaedori's `docs/hosting.md`), so Bun, Caddy and the firewall are there.
Run them as root on the server.

## 1. Get the code and a user for it

```sh
useradd --system --home /opt/anoesia --shell /usr/sbin/nologin anoesia
git clone https://github.com/lumiivera-cmyk/anoesia.git /opt/anoesia
cd /opt/anoesia
cp .env.example .env
```

## 2. Keys

Edit `/opt/anoesia/.env`: set `NANOGPT_API_KEY`, and set `ALLOWED_HOSTS` to
the address you'll open it at (like `ALLOWED_HOSTS=rp.yourdomain`, or
Amaedori's address if it goes under a path). Anoesia refuses other names. For Vertex AI, reuse
Amaedori's key file:

```sh
cp /opt/amaedori/gcp-key.json /opt/anoesia/gcp-key.json
```

and copy its three `GOOGLE_...` lines from `/opt/amaedori/.env`.

Then give the folder to the service's user:

```sh
chown -R anoesia:anoesia /opt/anoesia
chmod 600 /opt/anoesia/.env /opt/anoesia/gcp-key.json
```

## 3. A password

```sh
cd /opt/anoesia && sudo -u anoesia bun run set-password
```

Without one, the hosted app lets nobody in.

## 4. The service

```sh
cp deploy/anoesia.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now anoesia
systemctl status anoesia
```

## 5. The address

Point a DNS record (an A record, like `rp.yourdomain`) at the server, then
add the block in `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile` with
that address, and `systemctl reload caddy`. The snippet also shows how to
put it under a path of Amaedori's address instead.

## Updating

```sh
cd /opt/anoesia && sudo -u anoesia git pull && systemctl restart anoesia
```

## Backups

Everything is in `/opt/anoesia/data/anoesia.db`. Amaedori's nightly backup
only covers Amaedori; copying Anoesia's data folder into it comes later.
