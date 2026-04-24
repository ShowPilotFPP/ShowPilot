# OpenFalcon Deployment Guide

End-to-end setup for running OpenFalcon under git + PM2 with a one-command update flow.

## Initial install (one-time)

On the server (Linux LXC, VM, or bare metal):

```bash
# 1. Install Node.js 18+ if not present
# (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Install PM2 globally
sudo npm install -g pm2

# 3. Clone OpenFalcon
sudo git clone https://github.com/frankietest6/openfalcon.git /opt/openfalcon
sudo chown -R $USER:$USER /opt/openfalcon
cd /opt/openfalcon

# 4. Install deps
npm install --omit=dev

# 5. Configure
cp config.example.js config.js
# Edit config.js. At minimum:
#   - Generate a random jwtSecret:   openssl rand -hex 32
#   - Generate a random showToken:   openssl rand -hex 24
nano config.js

# 6. Start with PM2
pm2 start server.js --name openfalcon
pm2 save

# 7. Survive reboots
pm2 startup
# Run the command it prints (likely starts with `sudo env PATH=...`)
```

OpenFalcon should now be reachable at `http://your-server:3100/admin/`.

## Migrating an existing install to git

If you already had OpenFalcon installed via tarballs:

```bash
# Back it up first — paranoia
sudo mv /opt/openfalcon /opt/openfalcon.pre-git

# Stop existing
pkill -f "node server.js" 2>/dev/null

# Clone
sudo git clone https://github.com/frankietest6/openfalcon.git /opt/openfalcon
sudo chown -R $USER:$USER /opt/openfalcon
cd /opt/openfalcon
npm install --omit=dev

# Restore your config + database
cp /opt/openfalcon.pre-git/config.js .
cp -r /opt/openfalcon.pre-git/data .

# Start under PM2
pm2 start server.js --name openfalcon
pm2 save
pm2 startup    # run the printed command
```

## Day-to-day deploys

After the initial setup, every update is:

```bash
cd /opt/openfalcon
./deploy.sh
```

The script pulls, installs new deps if `package.json` changed, and reloads PM2 (zero downtime).

If you have SSH set up:
```bash
# From your dev machine, one-liner:
ssh user@openfalcon-host 'cd /opt/openfalcon && ./deploy.sh'
```

## Rolling back

If a deploy breaks something:

```bash
cd /opt/openfalcon
git log --oneline -10           # find a good commit
git checkout <commit-sha>       # detached HEAD — fine for emergencies
npm install --omit=dev
pm2 reload openfalcon
```

To get back to latest later: `git checkout main && ./deploy.sh`.

## Backing up

The two things you must back up:

```bash
# Config (contains your secrets)
cp /opt/openfalcon/config.js ~/openfalcon-backups/config.js.$(date +%F)

# Database
cp /opt/openfalcon/data/openfalcon.db ~/openfalcon-backups/openfalcon.db.$(date +%F)
```

Drop these into a cron job or your existing backup tooling. Recommended: nightly during show season.

## Logs

PM2 captures stdout/stderr automatically:

```bash
pm2 logs openfalcon
pm2 logs openfalcon --lines 200
pm2 logs openfalcon --err           # errors only
```

## Stopping / starting

```bash
pm2 stop openfalcon
pm2 start openfalcon
pm2 restart openfalcon       # full restart (~1s downtime)
pm2 reload openfalcon        # zero-downtime reload (preferred)
pm2 delete openfalcon        # remove from PM2 entirely
```
