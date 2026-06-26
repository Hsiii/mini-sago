# WM31Bot

WM31Bot is a Discord bot for managing channel access through slash commands.
It can run serverlessly on Vercel or as a containerized Next.js app on a VM.

## Use it

1. Install dependencies and create `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Optionally set `DISCORD_GUILD_ID` and `SELF_ASSIGNABLE_ROLES`.
4. Publish the slash commands.
5. Run locally or deploy, then point the Discord Interactions Endpoint URL at `/api/interactions`.

```bash
npm install
npm run register:commands
npm run dev
```

## Oracle Cloud Free Tier deployment

Oracle's current Always Free Ampere A1 allowance is 1,500 OCPU hours and
9,000 GB-hours per month, which is equivalent to one VM with 2 OCPUs and
12 GB RAM. This bot should run on a much smaller `VM.Standard.A1.Flex`
instance: 1 OCPU and 1 GB RAM. If building the image directly on the VM runs
out of memory, increase the VM to 2 GB RAM; that still stays inside Always
Free limits. See Oracle's Free Tier pages:

- <https://www.oracle.com/cloud/free/>
- <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>

Discord interaction endpoints must be public HTTPS URLs, so the included
Docker Compose stack runs the app behind Caddy for automatic TLS.

You need a domain or subdomain, such as `bot.example.com`, with a DNS `A`
record pointed at the Oracle VM public IP. Discord will not accept a plain
HTTP endpoint, and Caddy needs a hostname to issue a trusted TLS certificate.
No paid Oracle load balancer, database, object storage, or managed service is
required.

The included Caddy config also supports a `/wm31` path prefix, so you can use
`https://bot.example.com/wm31/api/interactions` while keeping `DOMAIN` set to
only `bot.example.com`.

1. Create an Oracle Cloud account and tenancy.
2. Create an Ampere A1 VM:
   - Image: Ubuntu 24.04 or 22.04.
   - Shape: `VM.Standard.A1.Flex`.
   - Size: 1 OCPU and 1 GB RAM.
   - Boot volume: 50 GB.
   - Networking: public subnet with a public IPv4 address.
   - Ingress: TCP `22`, `80`, and `443`.
3. Point your DNS `A` record to the VM public IP.
4. SSH into the VM and install Docker:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

5. Clone this repository onto the VM.
6. Create `.env.production` from `.env.production.example` and fill in:
   - `DOMAIN` without a path, such as `bot.example.com`
   - `ACME_EMAIL`
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `SELF_ASSIGNABLE_ROLES`
7. Start the service:

```bash
docker compose up -d --build
docker compose logs -f
```

8. Confirm the health endpoint:

```bash
curl https://$DOMAIN/wm31/api/health
```

9. In the Discord Developer Portal, set the Interactions Endpoint URL to:

```text
https://YOUR_DOMAIN/wm31/api/interactions
```

The production Compose stack caps runtime usage so the bot remains small:

- app container: 0.25 CPU and 256 MB RAM
- Caddy container: 0.25 CPU and 128 MB RAM

## Environment variables

| Name                     | Required | Description                                                                                                                      |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID` | Yes      | Discord application ID                                                                                                           |
| `DISCORD_PUBLIC_KEY`     | Yes      | Public key used to verify interaction signatures                                                                                 |
| `DISCORD_BOT_TOKEN`      | Yes      | Bot token used for Discord REST role updates                                                                                     |
| `DISCORD_GUILD_ID`       | No       | Restricts the bot to a single guild. Defaults to `1282936453134815275`                                                           |
| `SELF_ASSIGNABLE_ROLES`  | No       | JSON array of managed role configs. Defaults to the Wordle role `1451976411152781466` and Brawl Stars role `1450774352386719775` |

Default `SELF_ASSIGNABLE_ROLES` value:

```json
[
  {
    "id": "1451976411152781466",
    "label": "Wordle Channel",
    "description": "Access to the Wordle channel",
    "emoji": "🟩"
  },
  {
    "id": "1450774352386719775",
    "label": "Brawl Stars Channel",
    "description": "Access to the Brawl Stars channel",
    "emoji": "⭐"
  }
]
```
