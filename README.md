# Absentra

A lightweight, production-grade Slack app for leave request management. Request time off, get approvals, track balances, and see who's out - all from within Slack.

## Features

### For Employees
- **Request Time Off** - Submit leave requests with an intuitive modal interface
- **Track Balances** - View your remaining leave days by type with visual indicators
- **View Requests** - See your pending, approved, and past requests
- **Who's Out** - Check who's out today or upcoming days
- **Half-Day Support** - Request morning or afternoon half-days
- **View Company Leave Policy** - Access detailed leave policies and guidelines directly in Slack

### For Managers
- **Approve/Reject** - Review and approve leave requests via DM or Home tab
- **Team Overview** - See pending requests from your team members
- **One-Click Actions** - Approve or reject with optional notes
- **Bulk Management** - Paginated views for handling large teams

### For Admins
- **Team Management** - Create teams and assign managers
- **Leave Types** - Configure leave types with custom emoji, colors, and allowances
- **Balance Management** - Adjust individual user balances and set allowances
- **User Management** - Sync workspace users, assign admins
- **Workspace Settings** - Configure approval requirements, notification channels
- **Daily Digest** - Automated morning notifications showing who's out (timezone-aware)
- **Leave Policy Management** - Create and customize company leave policies within Slack
- **Comprehensive Dashboard** - Full admin interface for managing all aspects of the system

### Preview

![Home Tab](images/Home.png)

## Quick Start

### Prerequisites
- Node.js 20+
- A Slack workspace where you can install apps

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it "Absentra" and select your workspace

### 2. Configure App Permissions

Go to **OAuth & Permissions** and add these Bot Token Scopes:
- `chat:write` - Send messages
- `commands` - Add slash commands
- `users:read` - Read user info
- `users:read.email` - Read user emails
- `im:write` - Send DMs
- `im:history` - Read DM history

### 3. Enable Socket Mode

1. Go to **Socket Mode** and enable it
2. Generate an App-Level Token with `connections:write` scope
3. Save the token (starts with `xapp-`)

### 4. Create the Slash Command

Go to **Slash Commands** and create:
- Command: `/pto`
- Request URL: (leave blank for Socket Mode)
- Description: `Manage your time off`
- Usage Hint: `[request|balance|my|who|help]`

### 5. Enable Home Tab & Events

Go to **App Home**:
1. Enable the **Home Tab** feature
2. Subscribe to the `app_home_opened` event

### 6. Enable Interactivity

Go to **Interactivity & Shortcuts** and turn on Interactivity (no URL needed for Socket Mode).

### 7. Install the App

Go to **Install App** and install to your workspace. Save the Bot Token (starts with `xoxb-`).

### 8. Run the App

```bash
# Clone and setup
git clone https://github.com/your-org/absentra.git
cd absentra

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

Edit `.env` with your tokens:
```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
ADMIN_SLACK_ID=U012XPLLU3G
DATABASE_URL="file:./data/pto.db"
DEFAULT_TIMEZONE=America/New_York
```

```bash
# Setup database
npm run db:generate
npm run db:push

# Start the app
npm run dev
```

## Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Check health
curl http://localhost:3000/health
```

The container includes health checks at `/health` and `/ready` endpoints for orchestration.

## Commands Reference

| Command | Description |
|---------|-------------|
| `/pto request` | Open the leave request form |
| `/pto balance` | Check your leave balances |
| `/pto my` | View your leave requests |
| `/pto history` | View all past requests |
| `/pto who` | See who's out today |
| `/pto who week` | See who's out this week |
| `/pto pending` | View requests pending approval (managers) |
| `/pto admin` | Admin settings (admins only) |
| `/pto help` | Show help message |

## Default Leave Types

| Type | Emoji | Default Days | Requires Approval |
|------|-------|--------------|-------------------|
| PTO | 🏖️ | 20 | Yes |
| Sick Leave | 🤒 | 10 | No |
| Work From Home | 🏠 | Unlimited | No |
| Casual | 👤 | 5 | Yes |
| Unpaid Leave | 📋 | Unlimited | Yes |

## Configuration

### Setting Up Teams

1. Use the Admin Settings from the Home tab to create teams
2. Assign managers who can approve requests
3. Assign team members

### Daily Digest

To enable the daily digest notification:
1. Create a channel for announcements (e.g., `#whos-out`)
2. Invite Absentra to the channel
3. Configure the notification channel in Admin Settings

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token | Yes | - |
| `SLACK_SIGNING_SECRET` | Signing Secret | Yes | - |
| `SLACK_APP_TOKEN` | App-Level Token (Socket Mode) | Yes | - |
| `ADMIN_SLACK_ID` | User ID of first admin | Yes | - |
| `DATABASE_URL` | SQLite database path | Yes | - |
| `PORT` | HTTP server port for health checks | No | `3000` |
| `DEFAULT_TIMEZONE` | Default timezone for dates (uses workspace timezone if available) | No | `UTC` |
| `NODE_ENV` | Environment (`development`/`production`) | No | `production` |

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build for production
npm run build

# Start production server
npm start
```

## Database Management

```bash
# Generate Prisma client
npm run db:generate

# Push schema changes to database
npm run db:push

# Open Prisma Studio (database GUI)
npm run db:studio

# Run migrations (for production)
npm run db:migrate

# Seed default data
npm run db:seed
```

## Contributing

We welcome contributions! Here's how to get started:

### Reporting Issues

1. **Search existing issues** first to avoid duplicates
2. **Use the issue templates** when available
3. **Include details**:
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment (Node version, OS, Slack workspace type)
   - Error messages and logs

### Feature Requests

1. **Check the roadmap** and existing feature requests
2. **Describe the use case** - what problem does it solve?
3. **Propose a solution** if you have one in mind

### Pull Requests

1. **Fork the repository** and create a feature branch
2. **Follow the code style** - run `npm run lint` before committing
3. **Add tests** for new functionality
4. **Update documentation** if needed
5. **Write clear commit messages**

```bash
# Development workflow
git checkout -b feature/your-feature
npm run dev          # Make changes
npm test             # Run tests
npm run typecheck    # Check types
git commit -m "feat: your feature description"
git push origin feature/your-feature
```

### Code Guidelines

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Keep functions small and focused
- Add JSDoc comments for public APIs
- Use meaningful variable and function names

## Support

If you find Absentra useful, consider supporting its development:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Development-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/commit25uccess)

Your support helps maintain and improve Absentra for everyone!

## Troubleshooting

### Common Issues

**App not responding to commands**
- Verify Socket Mode is enabled and the app token is correct
- Check the app is running: `docker-compose logs -f`
- Ensure the bot is invited to the channel

**"expired_trigger_id" errors**
- This happens when a modal takes too long to open (>3 seconds)
- The app handles this gracefully with user-friendly messages and in-modal notifications

**Timezone issues**
- Absentra automatically uses your workspace timezone
- Ensure your Slack workspace has a timezone configured
- Falls back to `DEFAULT_TIMEZONE` environment variable if workspace timezone is unavailable

**Database errors**
- Run `npm run db:push` to sync the schema
- Check `DATABASE_URL` is set correctly
- Ensure the data directory has write permissions

**Health check failing**
- Verify port 3000 is accessible
- Check database connectivity: `curl http://localhost:3000/ready`

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Made with ❤️ for teams who value work-life balance.
