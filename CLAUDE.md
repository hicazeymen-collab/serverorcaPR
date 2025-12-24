# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Orca Render Server is a Node.js server that manages video rendering jobs for Premiere Pro reels. It receives render job requests via REST API, watches a directory for rendered MP4/MOV files, uploads them to Google Cloud Storage, and provides real-time updates via WebSocket to a dashboard GUI.

## Commands

```bash
# Install dependencies
npm install

# Run the server
npm start              # Production mode
npm run dev            # Development mode with nodemon (auto-restart)

# Windows Service management (run as Administrator)
node install-service.js    # Install as Windows service
node uninstall-service.js  # Uninstall Windows service

# Service control (PowerShell as Admin)
Start-Service "Orca Render Server"
Stop-Service "Orca Render Server"
Restart-Service "Orca Render Server"
```

## Architecture

### Core Components

- **server.js** - Single-file Express + Socket.IO server containing all server logic:
  - REST API endpoints (`GET /status`, `POST /render`)
  - WebSocket event handling for real-time dashboard updates
  - Job queue processing with `jobQueue` array and `processQueue()` function
  - File watcher using Chokidar that monitors `render_jobs_temp/` for MP4/MOV files
  - GCS upload with progress tracking via `uploadToGCS()`
  - External app notification via webhook to `APP_HOSTING_URL`

- **public/index.html** - Self-contained dashboard GUI with inline CSS/JS, connects via Socket.IO

### Data Flow

1. `POST /render` receives job JSON with `episodeId`, `episodeCode`, `podcastCode`, and `reels` array
2. Job saved to `render_jobs_temp/job-{episodeCode}-{timestamp}.json` and added to queue
3. Chokidar watches for new MP4/MOV files matching expected `reelName` from job
4. `waitForFileStability()` ensures file is completely written before upload
5. File uploaded to GCS at `reels_output/{podcastCode}/{episodeCode}/{filename}`
6. External app notified via POST to `NOTIFY_ENDPOINT`
7. Local files cleaned up after successful upload

### Key Configuration (in server.js)

- `PORT`: 6068
- `BUCKET_NAME`: "bathhadeethreels" (GCS bucket)
- `RENDER_JOBS_DIR`: `./render_jobs_temp`
- GCS credentials: `config/valiant-monitor-459014-p0-282c36407221.json`

### WebSocket Events

Server emits: `status-update`, `queue-update`, `log`, `job-started`, `job-completed`, `reel-completed`, `reel-failed`, `upload-started`, `upload-progress`, `file-detected`, `file-stability-progress`, `file-ready`

Client emits: `request-status`, `ping`

### Directory Structure

- `render_jobs_temp/` - Working directory for job JSON files and rendered video files (temporary)
- `daemon/` - Windows service logs (`.out.log`, `.err.log`, `.wrapper.log`)
- `config/` - GCS service account credentials
- `public/` - Static dashboard files
