# Zeabur Deployment Notes

## Resource Optimization for Free Tier

This bot has been optimized for Zeabur's free tier:

### Memory Optimizations
- **Puppeteer flags**: Added `--disable-dev-shm-usage`, `--disable-gpu`, and other memory-saving flags
- **Resource blocking**: Images, stylesheets, fonts, and media are blocked to reduce memory usage
- **Small viewport**: Uses 800x600 window size instead of full desktop
- **Single session**: Only one browser instance runs at a time (enforced by `isRunning` flag)

### CPU Optimizations
- **Scheduled runs**: Only active during 10:00-20:00 
- **10-minute intervals**: Checks every 10 minutes instead of continuous polling
- **Efficient waiting**: Uses event-based waiting instead of polling loops

### Expected Resource Usage
- **Idle**: ~50-80MB RAM (just Discord bot + Node.js)
- **During automation**: ~150-250MB RAM (with Puppeteer browser)
- **CPU**: Spikes during browser automation, otherwise minimal

## Environment Variables Required

Make sure to set these in Zeabur:
- `DISCORD_TOKEN` - Your Discord bot token
- `ENCRYPTION_KEY` - Secret key for encrypting restore codes

## Database Persistence

The `db.json` file stores account data. On Zeabur:
- Data persists between restarts
- The migration runs automatically on startup
- New accounts are encrypted before storage

## Deployment Steps

1. Push code to GitHub
2. Connect repository to Zeabur
3. Set environment variables
4. Deploy!

The bot will automatically:
- Run migration on first startup
- Start Discord bot
- Begin scheduled automation (10:00-20:00)
