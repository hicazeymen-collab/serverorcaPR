require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { Storage } = require('@google-cloud/storage');
const http = require('http');
const socketIO = require('socket.io');
const { exec, spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 6068;

// --- GCS and Webhook Configuration ---
const storage = new Storage({ keyFilename: path.join(__dirname, 'config/valiant-monitor-459014-p0-282c36407221.json') });
const BUCKET_NAME = "bathhadeethreels";
const APP_HOSTING_URL = "https://studio--taskflow-studio.us-central1.hosted.app";
const NOTIFY_ENDPOINT = `${APP_HOSTING_URL}/api/render-reels/worker`;

const RENDER_JOBS_DIR = path.join(__dirname, 'render_jobs_temp');
const FAILED_JOBS_DIR = path.join(__dirname, 'render_jobs_failed');

// Helper function to move failed jobs
async function moveJobToFailed(job) {
    try {
        await fs.mkdir(FAILED_JOBS_DIR, { recursive: true });
        const jsonFilename = `job-${job.episodeCode}-${job.timestamp}.json`;
        const sourcePath = path.join(RENDER_JOBS_DIR, jsonFilename);
        const destPath = path.join(FAILED_JOBS_DIR, jsonFilename);

        // Check if source exists
        try {
            await fs.access(sourcePath);
            await fs.rename(sourcePath, destPath);
            console.log(`[Failed Job] Moved job file to: ${destPath}`);
            io.emit('log', {
                message: `تم نقل الوظيفة الفاشلة: ${job.episodeCode}`,
                type: 'warning',
                details: `المسار: ${destPath}`
            });
        } catch (e) {
            // File doesn't exist, create it in failed folder
            await fs.writeFile(destPath, JSON.stringify(job, null, 2));
            console.log(`[Failed Job] Created job file in failed folder: ${destPath}`);
        }
    } catch (error) {
        console.error(`[Failed Job] Error moving job:`, error.message);
    }
}

// --- Premiere Pro Configuration ---
const PREMIERE_CONFIG = {
    // Default Premiere Pro paths (will check both)
    exePaths: [
        process.env.PREMIERE_EXE_PATH,
        'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\Adobe Premiere Pro.exe',
        'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2024\\Adobe Premiere Pro.exe',
        'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2023\\Adobe Premiere Pro.exe',
        'C:\\Program Files\\Adobe\\Adobe Premiere Pro CC 2022\\Adobe Premiere Pro.exe',
        'C:\\Program Files\\Adobe\\Adobe Premiere Pro CC\\Adobe Premiere Pro.exe'
    ].filter(Boolean),
    projectPath: process.env.PREMIERE_PROJECT_PATH || null,
    autoStart: process.env.PREMIERE_AUTO_START !== 'false', // Default true
    processName: 'Adobe Premiere Pro.exe'
};

// --- Premiere Pro Functions ---
function isPremiereRunning() {
    return new Promise((resolve) => {
        exec('tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /NH', { windowsHide: true }, (error, stdout) => {
            if (error) {
                console.error('[Premiere] Error checking process:', error.message);
                resolve(false);
                return;
            }
            const isRunning = stdout.toLowerCase().includes('adobe premiere pro');
            resolve(isRunning);
        });
    });
}

async function findPremiereExe() {
    const fsSync = require('fs');
    for (const exePath of PREMIERE_CONFIG.exePaths) {
        if (exePath && fsSync.existsSync(exePath)) {
            return exePath;
        }
    }
    return null;
}

async function startPremiere(projectPath = null) {
    const premiereExe = await findPremiereExe();

    if (!premiereExe) {
        console.error('[Premiere] Adobe Premiere Pro not found. Please set PREMIERE_EXE_PATH environment variable.');
        io.emit('log', {
            message: 'لم يتم العثور على Adobe Premiere Pro',
            type: 'error',
            details: 'يرجى تعيين متغير البيئة PREMIERE_EXE_PATH'
        });
        return false;
    }

    const project = projectPath || PREMIERE_CONFIG.projectPath;

    return new Promise((resolve) => {
        let args = [];
        let logMessage = 'جاري تشغيل Adobe Premiere Pro...';

        if (project) {
            const fsSync = require('fs');
            if (fsSync.existsSync(project)) {
                args.push(project);
                logMessage = `جاري فتح المشروع: ${path.basename(project)}`;
            } else {
                console.warn(`[Premiere] Project file not found: ${project}`);
                io.emit('log', {
                    message: 'ملف المشروع غير موجود',
                    type: 'warning',
                    details: project
                });
            }
        }

        console.log(`[Premiere] Starting: "${premiereExe}" ${args.join(' ')}`);
        io.emit('log', {
            message: logMessage,
            type: 'info'
        });

        const child = spawn(premiereExe, args, {
            detached: true,
            stdio: 'ignore'
        });

        child.unref();

        child.on('error', (err) => {
            console.error('[Premiere] Failed to start:', err.message);
            io.emit('log', {
                message: 'فشل تشغيل Adobe Premiere Pro',
                type: 'error',
                details: err.message
            });
            resolve(false);
        });

        // Give it a moment to start
        setTimeout(() => {
            console.log('[Premiere] Started successfully');
            io.emit('log', {
                message: 'تم تشغيل Adobe Premiere Pro بنجاح',
                type: 'success'
            });
            io.emit('premiere-started', { project: project || null });
            resolve(true);
        }, 2000);
    });
}

async function ensurePremiereRunning() {
    if (!PREMIERE_CONFIG.autoStart) {
        console.log('[Premiere] Auto-start is disabled');
        return true;
    }

    const isRunning = await isPremiereRunning();

    if (isRunning) {
        console.log('[Premiere] Already running');
        return true;
    }

    console.log('[Premiere] Not running, starting...');
    return await startPremiere();
}

// --- Helper Functions ---
async function notifyApp(episodeId, reelId, status, finalUrl = null, progress = 0, error = null) {
    const payload = { episodeId, reelId, status, finalUrl, progress, error };
    console.log(`[Notification] Sending to ${NOTIFY_ENDPOINT}:`, JSON.stringify(payload).substring(0, 500));

    // Emit to WebSocket clients
    io.emit('log', {
        message: `تحديث حالة الريل: ${status}`,
        type: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'info',
        details: `Reel ID: ${reelId}`
    });

    try {
        const fetch = (await import('node-fetch')).default;
        await fetch(NOTIFY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        console.log(`[Notification] Successfully notified app for reel ${reelId} with status ${status}.`);
    } catch (e) {
        console.error(`[Notification] Failed to notify app for reel ${reelId}:`, e.message);
    }
}

// Retry configuration for GCS uploads
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000  // 10 seconds max
};

// Job retry and queue configuration
const JOB_RETRY_CONFIG = {
    maxJobRetries: 3,                      // 3 retry attempts before permanent failure
    retryDelays: [60000, 300000, 600000],  // 1 min, 5 min, 10 min
    maxReelRetries: 2,                     // 2 retry attempts per reel
    baseTimeout: 600000,                   // 10 minutes base timeout
    perReelTimeout: 300000,                // 5 minutes per reel
};

// Health monitoring configuration
const HEALTH_MONITOR_CONFIG = {
    checkInterval: 30000,       // Check every 30 seconds
    stuckThreshold: 300000,     // 5 minutes without progress = stuck
    restartCooldown: 120000,    // 2 minutes between Premiere restarts
};

// SmartJobQueue Class - Priority queue with retry support
class SmartJobQueue {
    constructor() {
        this.queue = [];
        this.failedJobs = new Map(); // episodeCode -> job with failure info
        this.lastProgressTime = Date.now();
    }

    // Calculate priority: higher = processed first
    calculatePriority(job) {
        let priority = 0;

        // Retry jobs get +100 base priority
        if (job.retryCount > 0) {
            priority += 100;
        }

        // Smaller jobs (fewer reels) get higher priority
        const reelCount = job.reels?.length || 1;
        priority += Math.max(0, 20 - reelCount);

        return priority;
    }

    // Insert job maintaining priority order
    enqueue(job) {
        job.retryCount = job.retryCount || 0;
        job.reelRetries = job.reelRetries || {};
        job.priority = this.calculatePriority(job);
        job.queuedAt = Date.now();

        // Find insertion point (descending priority)
        let insertIndex = this.queue.findIndex(j => j.priority < job.priority);
        if (insertIndex === -1) insertIndex = this.queue.length;

        this.queue.splice(insertIndex, 0, job);
        return insertIndex;
    }

    // Get next job from queue
    dequeue() {
        return this.queue.shift();
    }

    // Get queue length
    get length() {
        return this.queue.length;
    }

    // Calculate dynamic timeout based on reel count
    calculateTimeout(job) {
        const reelCount = job.reels?.length || 1;
        return JOB_RETRY_CONFIG.baseTimeout + (reelCount * JOB_RETRY_CONFIG.perReelTimeout);
    }

    // Check if job should be retried
    shouldRetryJob(job) {
        return (job.retryCount || 0) < JOB_RETRY_CONFIG.maxJobRetries;
    }

    // Get retry delay based on attempt number
    getRetryDelay(retryCount) {
        const delays = JOB_RETRY_CONFIG.retryDelays;
        return delays[Math.min(retryCount, delays.length - 1)];
    }

    // Schedule job for retry
    scheduleRetry(job, reason) {
        job.retryCount = (job.retryCount || 0) + 1;
        job.lastFailureReason = reason;
        job.lastFailureTime = Date.now();

        const delay = this.getRetryDelay(job.retryCount - 1);
        job.scheduledRetryTime = Date.now() + delay;

        console.log(`[SmartQueue] Scheduling retry ${job.retryCount}/${JOB_RETRY_CONFIG.maxJobRetries} for ${job.episodeCode} in ${delay / 60000} minutes`);

        setTimeout(() => {
            this.enqueue(job);
            io.emit('job-requeued', {
                job,
                retryCount: job.retryCount,
                position: this.queue.length - 1
            });
            io.emit('log', {
                message: `تمت إعادة الوظيفة للطابور: ${job.episodeCode}`,
                type: 'info',
                details: `المحاولة ${job.retryCount + 1}/${JOB_RETRY_CONFIG.maxJobRetries + 1}`
            });
            emitQueueUpdate();
            process.nextTick(processQueue);
        }, delay);

        return { delay, retryCount: job.retryCount };
    }

    // Mark job as permanently failed
    markAsFailed(job) {
        job.failedAt = Date.now();
        job.status = 'failed';
        this.failedJobs.set(job.episodeCode, job);
        io.emit('failed-jobs-update', { failedJobs: this.getFailedJobs() });
        return job;
    }

    // Get all failed jobs
    getFailedJobs() {
        return Array.from(this.failedJobs.values());
    }

    // Retry a specific failed job
    retryFailedJob(episodeCode) {
        const job = this.failedJobs.get(episodeCode);
        if (!job) return null;

        // Reset retry count for manual retry
        job.retryCount = 0;
        job.reelRetries = {};
        job.manualRetry = true;
        delete job.failedAt;
        delete job.status;

        this.failedJobs.delete(episodeCode);
        const position = this.enqueue(job);

        io.emit('failed-jobs-update', { failedJobs: this.getFailedJobs() });

        return { job, position };
    }

    // Retry all failed jobs
    retryAllFailed() {
        const jobs = this.getFailedJobs();
        const results = [];

        for (const job of jobs) {
            const result = this.retryFailedJob(job.episodeCode);
            if (result) results.push(result);
        }

        return results;
    }

    // Delete a failed job permanently
    deleteFailedJob(episodeCode) {
        const deleted = this.failedJobs.delete(episodeCode);
        if (deleted) {
            io.emit('failed-jobs-update', { failedJobs: this.getFailedJobs() });
        }
        return deleted;
    }

    // Update progress timestamp for health monitoring
    recordProgress() {
        this.lastProgressTime = Date.now();
    }

    // Check if processing is stuck
    isStuck() {
        if (!isProcessing) return false;
        return (Date.now() - this.lastProgressTime) > HEALTH_MONITOR_CONFIG.stuckThreshold;
    }

    // Find job in queue by episodeCode
    findIndex(episodeCode) {
        return this.queue.findIndex(j => j.episodeCode === episodeCode);
    }

    // Remove job from queue by index
    removeAt(index) {
        if (index >= 0 && index < this.queue.length) {
            return this.queue.splice(index, 1)[0];
        }
        return null;
    }
}

// HealthMonitor Class - Monitors Premiere Pro and processing health
class HealthMonitor {
    constructor() {
        this.checkInterval = null;
        this.lastPremiereRestart = 0;
    }

    start() {
        if (this.checkInterval) return;

        this.checkInterval = setInterval(() => this.checkHealth(), HEALTH_MONITOR_CONFIG.checkInterval);
        console.log('[HealthMonitor] Started monitoring every 30 seconds');
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            console.log('[HealthMonitor] Stopped monitoring');
        }
    }

    async checkHealth() {
        // Check if processing is stuck
        if (smartQueue.isStuck()) {
            console.warn('[HealthMonitor] Processing appears stuck - no progress for 5 minutes');

            io.emit('health-warning', {
                type: 'stuck',
                message: 'المعالجة متوقفة - لم يتم إحراز أي تقدم لمدة 5 دقائق'
            });
            io.emit('log', {
                message: 'تحذير: المعالجة متوقفة',
                type: 'warning',
                details: 'لم يتم إحراز أي تقدم لمدة 5 دقائق'
            });

            // Check Premiere Pro status
            const premiereRunning = await isPremiereRunning();

            if (!premiereRunning && isProcessing) {
                console.warn('[HealthMonitor] Premiere Pro not running during processing - attempting restart');
                await this.restartPremiere();
            }
        }

        // Periodic Premiere Pro check during processing
        if (isProcessing) {
            const premiereRunning = await isPremiereRunning();
            if (!premiereRunning) {
                console.warn('[HealthMonitor] Premiere Pro crashed during processing');
                io.emit('health-warning', {
                    type: 'premiere_crash',
                    message: 'توقف Adobe Premiere Pro أثناء المعالجة'
                });
                await this.restartPremiere();
            }
        }
    }

    async restartPremiere() {
        const now = Date.now();
        const cooldown = HEALTH_MONITOR_CONFIG.restartCooldown;

        if (now - this.lastPremiereRestart < cooldown) {
            console.log('[HealthMonitor] Premiere restart on cooldown, skipping');
            return false;
        }

        this.lastPremiereRestart = now;

        io.emit('log', {
            message: 'جاري إعادة تشغيل Adobe Premiere Pro تلقائياً...',
            type: 'warning'
        });
        io.emit('premiere-restarting', {});

        // Kill any hanging Premiere process first
        await this.killPremiere();
        await sleep(3000);

        // Start Premiere
        const started = await startPremiere();

        if (started) {
            // Update progress time to give Premiere time to initialize
            smartQueue.recordProgress();

            io.emit('log', {
                message: 'تم إعادة تشغيل Premiere Pro بنجاح',
                type: 'success'
            });
            io.emit('premiere-restarted', {});
            return true;
        }

        return false;
    }

    async killPremiere() {
        return new Promise((resolve) => {
            exec('taskkill /IM "Adobe Premiere Pro.exe" /F', { windowsHide: true }, (error) => {
                if (error) {
                    console.log('[HealthMonitor] No Premiere process to kill or error:', error.message);
                } else {
                    console.log('[HealthMonitor] Premiere Pro process killed');
                }
                resolve();
            });
        });
    }
}

// Initialize SmartJobQueue and HealthMonitor
const smartQueue = new SmartJobQueue();
const healthMonitor = new HealthMonitor();

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadToGCS(localPath, gcsPath, onProgress, retryCount = 0) {
    console.log(`[GCS Upload] Starting upload of ${localPath} to gs://${BUCKET_NAME}/${gcsPath}${retryCount > 0 ? ` (Retry ${retryCount}/${RETRY_CONFIG.maxRetries})` : ''}`);
    try {
        // Get file size for progress calculation
        const stats = await fs.stat(localPath);
        const fileSize = stats.size;
        let uploadedBytes = 0;
        let lastReportedPercent = 0;

        // Create a readable stream from the file
        const fileStream = require('fs').createReadStream(localPath);
        const bucket = storage.bucket(BUCKET_NAME);
        const blob = bucket.file(gcsPath);

        // Create write stream with resumable upload
        const blobStream = blob.createWriteStream({
            resumable: fileSize > 5 * 1024 * 1024, // Use resumable for files > 5MB
            metadata: {
                cacheControl: 'public, max-age=31536000',
            },
        });

        return new Promise((resolve, reject) => {
            // Track upload progress
            fileStream.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                const percent = Math.round((uploadedBytes / fileSize) * 100);

                // Only report every 5% to avoid flooding
                if (percent >= lastReportedPercent + 5 || percent === 100) {
                    lastReportedPercent = percent;
                    console.log(`[GCS Upload] Progress: ${percent}% (${(uploadedBytes / 1024 / 1024).toFixed(2)} MB / ${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

                    if (onProgress) {
                        onProgress({
                            percent,
                            uploadedBytes,
                            totalBytes: fileSize,
                            uploadedMB: (uploadedBytes / 1024 / 1024).toFixed(2),
                            totalMB: (fileSize / 1024 / 1024).toFixed(2)
                        });
                    }
                }
            });

            blobStream.on('error', (err) => {
                console.error(`[GCS Upload] Stream error for ${gcsPath}:`, err.message);
                reject(new Error(`Failed to upload file to GCS: ${gcsPath}. ${err}`));
            });

            blobStream.on('finish', async () => {
                try {
                    await blob.makePublic();
                    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;
                    console.log(`[GCS Upload] Successful: ${publicUrl}`);
                    resolve(publicUrl);
                } catch (e) {
                    reject(e);
                }
            });

            // Pipe the file to GCS
            fileStream.pipe(blobStream);
        });
    } catch (e) {
        console.error(`[GCS Upload] Failed for ${gcsPath}:`, e.message);

        // Retry logic with exponential backoff
        if (retryCount < RETRY_CONFIG.maxRetries) {
            const delay = Math.min(
                RETRY_CONFIG.baseDelay * Math.pow(2, retryCount),
                RETRY_CONFIG.maxDelay
            );
            console.log(`[GCS Upload] Retrying in ${delay/1000}s... (${retryCount + 1}/${RETRY_CONFIG.maxRetries})`);

            // Emit retry event
            io.emit('upload-retry', {
                gcsPath,
                retryCount: retryCount + 1,
                maxRetries: RETRY_CONFIG.maxRetries,
                delayMs: delay,
                error: e.message
            });
            io.emit('log', {
                message: `إعادة محاولة الرفع (${retryCount + 1}/${RETRY_CONFIG.maxRetries})`,
                type: 'warning',
                details: `انتظار ${delay/1000} ثانية...`
            });

            await sleep(delay);
            return uploadToGCS(localPath, gcsPath, onProgress, retryCount + 1);
        }

        throw new Error(`Failed to upload file to GCS after ${RETRY_CONFIG.maxRetries} retries: ${gcsPath}. ${e}`);
    }
}

// --- Main Server Logic ---
// Note: jobQueue replaced by smartQueue (SmartJobQueue class)
let isProcessing = false;
let watcher = null;
let currentJob = null; // Track currently processing job
let jobCancelled = false; // Flag for job cancellation
const processedFilesInJob = new Set();
const reelProgressMap = new Map(); // Track reel progress per job

// Upload history tracking - grouped by episode code
const uploadHistory = new Map(); // Map<episodeCode, Array<{fileName, url, timestamp, podcastCode}>>
const MAX_HISTORY_PER_EPISODE = 50; // Keep last 50 files per episode
const MAX_EPISODES_IN_HISTORY = 20; // Keep last 20 episodes

function addToUploadHistory(episodeCode, podcastCode, fileName, url) {
    const entry = {
        fileName,
        url,
        timestamp: new Date().toISOString(),
        podcastCode
    };

    if (!uploadHistory.has(episodeCode)) {
        uploadHistory.set(episodeCode, []);
    }

    const episodeHistory = uploadHistory.get(episodeCode);
    episodeHistory.unshift(entry); // Add to beginning

    // Limit per episode
    if (episodeHistory.length > MAX_HISTORY_PER_EPISODE) {
        episodeHistory.pop();
    }

    // Limit total episodes (remove oldest)
    if (uploadHistory.size > MAX_EPISODES_IN_HISTORY) {
        const keys = Array.from(uploadHistory.keys());
        uploadHistory.delete(keys[0]);
    }

    // Emit update to clients
    io.emit('upload-history-update', getUploadHistoryForClient());
}

function getUploadHistoryForClient() {
    const result = [];
    uploadHistory.forEach((files, episodeCode) => {
        result.push({
            episodeCode,
            podcastCode: files[0]?.podcastCode || 'N/A',
            files: files,
            totalFiles: files.length
        });
    });
    // Sort by most recent upload
    result.sort((a, b) => {
        const aTime = a.files[0]?.timestamp || '';
        const bTime = b.files[0]?.timestamp || '';
        return bTime.localeCompare(aTime);
    });
    return result;
}

// File stability check - wait for file to finish writing
async function waitForFileStability(filePath, fileName, onProgress) {
    const stabilityTime = 2000; // 2 seconds of stability required
    const maxWait = 300000; // 5 minutes max wait
    const requiredStableChecks = 3; // 3 consecutive checks with same size
    const checkInterval = Math.floor(stabilityTime / requiredStableChecks);

    let lastSize = -1;
    let stableCount = 0;
    const startTime = Date.now();

    console.log(`[File Stability] Waiting for file to finish writing: ${fileName}`);

    while (Date.now() - startTime < maxWait) {
        try {
            const stats = await fs.stat(filePath);
            const currentSize = stats.size;
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

            // Report progress
            if (onProgress) {
                onProgress({
                    status: 'waiting',
                    currentSize,
                    currentSizeMB: (currentSize / 1024 / 1024).toFixed(2),
                    elapsedSeconds,
                    isGrowing: currentSize !== lastSize
                });
            }

            if (currentSize === lastSize && currentSize > 0) {
                stableCount++;
                console.log(`[File Stability] ${fileName}: Size stable at ${(currentSize / 1024 / 1024).toFixed(2)} MB (${stableCount}/${requiredStableChecks})`);

                if (stableCount >= requiredStableChecks) {
                    console.log(`[File Stability] ${fileName}: File is stable and ready for upload`);
                    return { stable: true, finalSize: currentSize };
                }
            } else {
                if (stableCount > 0) {
                    console.log(`[File Stability] ${fileName}: Size changed, resetting stability counter`);
                }
                stableCount = 0;
            }

            lastSize = currentSize;
            await new Promise(r => setTimeout(r, checkInterval));
        } catch (err) {
            // File might be locked or temporarily unavailable
            console.log(`[File Stability] ${fileName}: Waiting for file access...`);
            await new Promise(r => setTimeout(r, checkInterval));
        }
    }

    console.warn(`[File Stability] ${fileName}: Timeout waiting for file stability`);
    return { stable: false, finalSize: lastSize };
}


async function setupWatcher() {
    if (watcher) return;
    
    await fs.mkdir(RENDER_JOBS_DIR, { recursive: true });
    console.log(`[Watcher] Setting up new file watcher for directory: ${RENDER_JOBS_DIR}`);

    watcher = chokidar.watch(RENDER_JOBS_DIR, {
        ignored: /(^|[\/\\])\..*|.*\.json$/, // Ignore dotfiles and json files
        persistent: true,
        ignoreInitial: true,
    });
    
    watcher.on('error', (error) => {
        console.error(`[Watcher] Error:`, error);
    });
}


async function processQueue() {
    if (isProcessing || smartQueue.length === 0) {
        return;
    }
    isProcessing = true;
    jobCancelled = false; // Reset cancellation flag
    const job = smartQueue.dequeue();
    currentJob = job; // Track current job for cancellation
    const { episodeId, reels, podcastCode, episodeCode } = job;

    // Calculate dynamic timeout based on number of reels
    const dynamicTimeout = smartQueue.calculateTimeout(job);
    const timeoutMinutes = Math.round(dynamicTimeout / 60000);

    console.log(`[Queue] Starting processing for job: ${episodeCode}`);
    console.log(`[Queue] Dynamic timeout: ${timeoutMinutes} minutes for ${reels.length} reels`);

    // Record progress for health monitoring
    smartQueue.recordProgress();

    // Log retry info if applicable
    if (job.retryCount > 0) {
        console.log(`[Queue] This is retry attempt ${job.retryCount}/${JOB_RETRY_CONFIG.maxJobRetries}`);
        io.emit('log', {
            message: `إعادة محاولة الوظيفة: ${episodeCode}`,
            type: 'warning',
            details: `المحاولة ${job.retryCount + 1}/${JOB_RETRY_CONFIG.maxJobRetries + 1}`
        });
    }

    // Emit job started event
    io.emit('job-started', { ...job, dynamicTimeout, timeoutMinutes });
    io.emit('log', {
        message: `بدء معالجة الوظيفة: ${episodeCode}`,
        type: 'info',
        details: `${reels.length} ريل - المهلة: ${timeoutMinutes} دقيقة`
    });

    // Initialize reel progress tracking
    const progressKey = episodeCode;
    reelProgressMap.set(progressKey, {
        completed: 0,
        total: reels.length,
        reels: Object.fromEntries(reels.map(r => [r.id, 'pending']))
    });

    emitQueueUpdate();

    const reelMapByFilenameBase = new Map(reels.map((r) => {
        const baseName = r.reelName ? path.basename(r.reelName, path.extname(r.reelName)) : null;
        return [baseName, r];
    }).filter(([baseName, _]) => baseName));

    console.log("[Job Processor] Expecting reels with base names:", Array.from(reelMapByFilenameBase.keys()));

    const processedReelIds = new Set();
    const totalReelsToProcess = reelMapByFilenameBase.size;

    if (totalReelsToProcess === 0) {
        console.warn("[Job Processor] Job has no valid reels to process. Finishing job.");
        currentJob = null;
        isProcessing = false;
        process.nextTick(processQueue);
        return;
    }

    // Check for existing files before starting the watcher
    console.log("[Job Processor] Checking for existing files in directory...");
    try {
        const existingFiles = await fs.readdir(RENDER_JOBS_DIR);
        const validExtensions = ['.mp4', '.mov'];

        for (const fileName of existingFiles) {
            const fileExt = path.extname(fileName).toLowerCase();
            if (!validExtensions.includes(fileExt)) continue;

            const fileNameWithoutExt = path.basename(fileName, fileExt);
            const reelData = reelMapByFilenameBase.get(fileNameWithoutExt);

            if (reelData && reelData.id) {
                console.log(`[Job Processor] Found existing file: ${fileName} matching reel ${reelData.id}`);
                const filePath = path.join(RENDER_JOBS_DIR, fileName);
                // Process this file immediately
                await processFile(filePath, fileName, fileNameWithoutExt, reelData);
            }
        }
    } catch (err) {
        console.error("[Job Processor] Error checking for existing files:", err);
    }

    // Function to process a file (used for both existing and new files)
    async function processFile(filePath, fileName, _fileNameWithoutExt, reelData) {
        if (processedFilesInJob.has(fileName)) {
            return; // Already processed
        }

        processedFilesInJob.add(fileName);

        // Update reel status to uploading
        const progress = reelProgressMap.get(progressKey);
        if (progress) {
            progress.reels[reelData.id] = { status: 'uploading', uploadPercent: 0 };
            emitQueueUpdate();
        }

        // Emit upload started event
        io.emit('upload-started', {
            fileName,
            reelId: reelData.id,
            episodeCode
        });

        try {
            await notifyApp(episodeId, reelData.id, 'uploading', null, 50);
            const gcsOutputPath = `reels_output/${podcastCode}/${episodeCode}/${fileName}`;

            // Upload with progress callback
            const finalUrl = await uploadToGCS(filePath, gcsOutputPath, (uploadProgress) => {
                // Update progress in map
                if (progress) {
                    progress.reels[reelData.id] = {
                        status: 'uploading',
                        uploadPercent: uploadProgress.percent,
                        uploadedMB: uploadProgress.uploadedMB,
                        totalMB: uploadProgress.totalMB
                    };
                    emitQueueUpdate();
                }

                // Emit upload progress event
                io.emit('upload-progress', {
                    fileName,
                    reelId: reelData.id,
                    episodeCode,
                    percent: uploadProgress.percent,
                    uploadedMB: uploadProgress.uploadedMB,
                    totalMB: uploadProgress.totalMB
                });
            });

            await notifyApp(episodeId, reelData.id, 'completed', finalUrl, 100);
            processedReelIds.add(reelData.id);

            // Update reel status to completed
            if (progress) {
                progress.reels[reelData.id] = 'completed';
                progress.completed++;
                emitQueueUpdate();
            }

            // Emit reel completed event
            io.emit('reel-completed', {
                fileName,
                url: finalUrl,
                episodeCode
            });
            io.emit('log', {
                message: `تم رفع الريل بنجاح: ${fileName}`,
                type: 'success',
                details: finalUrl
            });

            // Add to upload history
            addToUploadHistory(episodeCode, podcastCode, fileName, finalUrl);

            // Clean up the local file after upload
            await fs.unlink(filePath).catch(err => console.error(`Failed to delete local file ${filePath}:`, err));
            console.log(`[Cleanup] Deleted local file: ${filePath}`);

            console.log(`[Job Progress] Processed ${processedReelIds.size} of ${totalReelsToProcess} reels for job ${episodeCode}.`);

            if (processedReelIds.size === totalReelsToProcess) {
                console.log(`[Job Complete] All ${totalReelsToProcess} reels for job ${episodeCode} have been processed.`);
                watcher?.off('add', onFileAdd); // Remove listener for this job
                clearTimeout(jobTimeout);

                // Emit job completed event
                io.emit('job-completed', job);
                io.emit('log', {
                    message: `اكتملت الوظيفة: ${episodeCode}`,
                    type: 'success',
                    details: `تم معالجة جميع الـ ${totalReelsToProcess} ريلات`
                });

                // Cleanup job JSON
                const jsonFilename = `job-${episodeCode}-${job.timestamp}.json`;
                const jsonFilePath = path.join(RENDER_JOBS_DIR, jsonFilename);
                await fs.unlink(jsonFilePath).catch(err => console.error(`Failed to delete job file ${jsonFilePath}:`, err));
                console.log(`[Cleanup] Deleted job file: ${jsonFilePath}`);

                reelProgressMap.delete(progressKey);
                processedFilesInJob.clear();
                currentJob = null;
                isProcessing = false;
                emitQueueUpdate();
                process.nextTick(processQueue);
            }
        } catch (uploadError) {
            console.error(`[Job Processor] Error processing file ${fileName}:`, uploadError);
            await notifyApp(episodeId, reelData.id, 'failed', null, 100, uploadError.message);

            // Update reel status to failed
            if (progress) {
                progress.reels[reelData.id] = 'failed';
                emitQueueUpdate();
            }

            // Emit reel failed event
            io.emit('reel-failed', {
                fileName,
                error: uploadError.message,
                episodeCode
            });
            io.emit('log', {
                message: `فشل رفع الريل: ${fileName}`,
                type: 'error',
                details: uploadError.message
            });

            processedReelIds.add(reelData.id); // Count as "processed" to avoid hung job
            if (processedReelIds.size === totalReelsToProcess) {
                watcher?.off('add', onFileAdd);
                clearTimeout(jobTimeout);
                reelProgressMap.delete(progressKey);
                currentJob = null;
                isProcessing = false;
                emitQueueUpdate();
                process.nextTick(processQueue);
            }
        }
    }

    // Function to handle job cancellation cleanup
    function cleanupCancelledJob() {
        console.log(`[Job Cancelled] Cleaning up cancelled job: ${episodeCode}`);
        watcher?.off('add', onFileAdd);
        clearTimeout(jobTimeout);

        // Notify remaining reels as cancelled
        reels.forEach((reel) => {
            if (!processedReelIds.has(reel.id)) {
                notifyApp(episodeId, reel.id, 'failed', null, 0, "Job was cancelled by user.");
            }
        });

        io.emit('job-cancelled', { job, reason: 'user_request' });
        io.emit('log', {
            message: `تم إلغاء الوظيفة: ${episodeCode}`,
            type: 'warning',
            details: 'تم إلغاء الوظيفة بناءً على طلب المستخدم'
        });

        // Cleanup
        const jsonFilename = `job-${episodeCode}-${job.timestamp}.json`;
        const jsonFilePath = path.join(RENDER_JOBS_DIR, jsonFilename);
        fs.unlink(jsonFilePath).catch(() => {});

        reelProgressMap.delete(progressKey);
        processedFilesInJob.clear();
        currentJob = null;
        jobCancelled = false;
        isProcessing = false;
        emitQueueUpdate();
        process.nextTick(processQueue);
    }

    const onFileAdd = async (filePath) => {
        // Check for cancellation before processing
        if (jobCancelled) {
            cleanupCancelledJob();
            return;
        }
        const fileName = path.basename(filePath);
        const fileExt = path.extname(fileName).toLowerCase();
        const validExtensions = ['.mp4', '.mov'];

        if (!validExtensions.includes(fileExt) || processedFilesInJob.has(fileName)) {
            return;
        }

        const fileNameWithoutExt = path.basename(fileName, fileExt);
        console.log(`[Watcher] Detected video file: ${fileName}. Base name: "${fileNameWithoutExt}"`);

        const reelData = reelMapByFilenameBase.get(fileNameWithoutExt);
        if (!reelData || !reelData.id) {
            console.warn(`[Watcher] File base name "${fileNameWithoutExt}" does not correspond to any known reel in the current job. Ignoring.`);
            return;
        }

        // Update status to waiting for file completion
        const progress = reelProgressMap.get(progressKey);
        if (progress) {
            progress.reels[reelData.id] = { status: 'waiting', currentSizeMB: '0' };
            emitQueueUpdate();
        }

        // Emit file detected event
        io.emit('file-detected', {
            fileName,
            reelId: reelData.id,
            episodeCode
        });
        io.emit('log', {
            message: `تم اكتشاف الملف: ${fileName}`,
            type: 'info',
            details: 'انتظار اكتمال الكتابة...'
        });

        // Wait for file to finish writing (Premiere Pro may still be rendering)
        const stabilityResult = await waitForFileStability(filePath, fileName, (stabilityProgress) => {
            // Update UI with file writing progress
            if (progress) {
                progress.reels[reelData.id] = {
                    status: 'waiting',
                    currentSizeMB: stabilityProgress.currentSizeMB,
                    isGrowing: stabilityProgress.isGrowing,
                    elapsedSeconds: stabilityProgress.elapsedSeconds
                };
                emitQueueUpdate();
            }

            // Emit stability progress event
            io.emit('file-stability-progress', {
                fileName,
                reelId: reelData.id,
                episodeCode,
                currentSizeMB: stabilityProgress.currentSizeMB,
                isGrowing: stabilityProgress.isGrowing,
                elapsedSeconds: stabilityProgress.elapsedSeconds
            });
        });

        if (!stabilityResult.stable) {
            console.error(`[Watcher] File ${fileName} did not stabilize in time. Skipping.`);
            io.emit('log', {
                message: `فشل انتظار اكتمال الملف: ${fileName}`,
                type: 'error',
                details: 'انتهت مهلة الانتظار (5 دقائق)'
            });

            if (progress) {
                progress.reels[reelData.id] = { status: 'failed' };
                emitQueueUpdate();
            }
            return;
        }

        // File is stable, emit ready event
        io.emit('file-ready', {
            fileName,
            reelId: reelData.id,
            episodeCode,
            finalSizeMB: (stabilityResult.finalSize / 1024 / 1024).toFixed(2)
        });
        io.emit('log', {
            message: `الملف جاهز للرفع: ${fileName}`,
            type: 'success',
            details: `الحجم: ${(stabilityResult.finalSize / 1024 / 1024).toFixed(2)} MB`
        });

        // Use the shared processFile function
        await processFile(filePath, fileName, fileNameWithoutExt, reelData);
    };
    
    watcher.on('add', onFileAdd);

    const jobTimeout = setTimeout(async () => {
         console.error(`[Job Timeout] Job for ${episodeCode} timed out after ${timeoutMinutes} minutes.`);
         watcher?.off('add', onFileAdd);

         // Check if job should be retried
         if (smartQueue.shouldRetryJob(job)) {
             // Schedule retry
             const { delay, retryCount } = smartQueue.scheduleRetry(job, 'timeout');
             const delayMinutes = Math.round(delay / 60000);

             io.emit('log', {
                 message: `انتهت مهلة الوظيفة: ${episodeCode}`,
                 type: 'warning',
                 details: `سيتم إعادة المحاولة بعد ${delayMinutes} دقيقة (المحاولة ${retryCount}/${JOB_RETRY_CONFIG.maxJobRetries})`
             });
             io.emit('job-scheduled-retry', {
                 job,
                 delay,
                 retryCount,
                 reason: 'timeout'
             });

             // Don't notify app as failed yet - we're retrying
             console.log(`[Job Timeout] Job ${episodeCode} will retry in ${delayMinutes} minutes`);
         } else {
             // Max retries exceeded - permanent failure
             console.error(`[Job Timeout] Job ${episodeCode} exceeded max retries, marking as permanently failed`);

             reels.forEach((reel) => {
                 if (!processedReelIds.has(reel.id)) {
                     notifyApp(episodeId, reel.id, 'failed', null, 100, "Render job timed out after all retry attempts.");
                 }
             });

             io.emit('log', {
                 message: `فشلت الوظيفة نهائياً: ${episodeCode}`,
                 type: 'error',
                 details: `تم استنفاد جميع المحاولات (${JOB_RETRY_CONFIG.maxJobRetries + 1})`
             });
             io.emit('job-permanently-failed', {
                 job,
                 reason: 'max_retries_exceeded'
             });

             // Move job to Failed folder
             await moveJobToFailed(job);
             smartQueue.markAsFailed(job);
         }

         reelProgressMap.delete(progressKey);
         currentJob = null;
         isProcessing = false;
         emitQueueUpdate();
         process.nextTick(processQueue);
    }, dynamicTimeout);

    // Also check for cancellation periodically
    const cancellationCheck = setInterval(() => {
        if (jobCancelled) {
            clearInterval(cancellationCheck);
            cleanupCancelledJob();
        }
    }, 1000);
}

// Helper function to emit queue updates
function emitQueueUpdate() {
    const queueWithProgress = smartQueue.queue.map((job, index) => {
        const baseJob = { ...job };

        // Add progress data to the currently processing job
        if (index === 0 && isProcessing) {
            const progress = reelProgressMap.get(job.episodeCode);
            baseJob.reelProgress = progress;
        }

        // Include retry info
        baseJob.isRetry = (job.retryCount || 0) > 0;
        baseJob.retryInfo = {
            count: job.retryCount || 0,
            maxRetries: JOB_RETRY_CONFIG.maxJobRetries,
            scheduledRetryTime: job.scheduledRetryTime
        };

        return baseJob;
    });

    io.emit('queue-update', queueWithProgress);
    io.emit('failed-jobs-update', { failedJobs: smartQueue.getFailedJobs() });
    io.emit('status-update', {
        queueLength: smartQueue.length,
        failedCount: smartQueue.failedJobs.size,
        isProcessing
    });
}


// --- Express Routes ---
app.get('/status', async (_req, res) => {
    const premiereRunning = await isPremiereRunning();
    res.status(200).json({
        status: 'ok',
        message: `Render V2 server is running.`,
        queueLength: smartQueue.length,
        failedCount: smartQueue.failedJobs.size,
        isProcessing,
        watching: watcher ? RENDER_JOBS_DIR : "Not watching",
        premiere: {
            running: premiereRunning,
            autoStart: PREMIERE_CONFIG.autoStart,
            projectPath: PREMIERE_CONFIG.projectPath
        }
    });
});

// Premiere Pro control endpoints
app.get('/premiere/status', async (_req, res) => {
    const isRunning = await isPremiereRunning();
    res.status(200).json({
        running: isRunning,
        autoStart: PREMIERE_CONFIG.autoStart,
        projectPath: PREMIERE_CONFIG.projectPath
    });
});

app.post('/premiere/start', async (req, res) => {
    const { projectPath } = req.body || {};
    const isRunning = await isPremiereRunning();

    if (isRunning) {
        return res.status(200).json({
            message: 'Adobe Premiere Pro is already running.',
            status: 'already_running'
        });
    }

    const started = await startPremiere(projectPath || null);

    if (started) {
        return res.status(200).json({
            message: 'Adobe Premiere Pro started successfully.',
            status: 'started'
        });
    } else {
        return res.status(500).json({
            error: 'Failed to start Adobe Premiere Pro.',
            status: 'failed'
        });
    }
});

// Upload history endpoint
app.get('/uploads/history', (_req, res) => {
    res.status(200).json({
        history: getUploadHistoryForClient(),
        totalEpisodes: uploadHistory.size
    });
});

// ===== Failed Jobs Management API =====

// Get all failed jobs
app.get('/failed-jobs', async (_req, res) => {
    try {
        // Get from memory
        const memoryFailed = smartQueue.getFailedJobs();

        // Also scan failed jobs directory for persisted failures
        let diskFailed = [];
        try {
            const files = await fs.readdir(FAILED_JOBS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            for (const file of jsonFiles) {
                const content = await fs.readFile(path.join(FAILED_JOBS_DIR, file), 'utf8');
                const job = JSON.parse(content);
                // Only add if not already in memory
                if (!memoryFailed.find(j => j.episodeCode === job.episodeCode)) {
                    job.fromDisk = true;
                    diskFailed.push(job);
                }
            }
        } catch (e) {
            // Directory might not exist - that's ok
        }

        const allFailed = [...memoryFailed, ...diskFailed];

        res.status(200).json({
            failedJobs: allFailed,
            count: allFailed.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Retry a specific failed job
app.post('/failed-jobs/:episodeCode/retry', async (req, res) => {
    const { episodeCode } = req.params;

    try {
        // Check memory first
        let result = smartQueue.retryFailedJob(episodeCode);

        if (!result) {
            // Check disk
            const files = await fs.readdir(FAILED_JOBS_DIR).catch(() => []);
            const matchingFile = files.find(f => f.includes(episodeCode) && f.endsWith('.json'));

            if (matchingFile) {
                const content = await fs.readFile(path.join(FAILED_JOBS_DIR, matchingFile), 'utf8');
                const job = JSON.parse(content);

                // Reset and enqueue
                job.retryCount = 0;
                job.reelRetries = {};
                job.manualRetry = true;
                delete job.failedAt;
                delete job.status;

                const position = smartQueue.enqueue(job);

                // Remove from failed directory
                await fs.unlink(path.join(FAILED_JOBS_DIR, matchingFile));

                result = { job, position };
            }
        }

        if (result) {
            io.emit('job-requeued', result);
            io.emit('log', {
                message: `تم إعادة الوظيفة للطابور: ${episodeCode}`,
                type: 'success'
            });
            emitQueueUpdate();
            process.nextTick(processQueue);

            res.status(200).json({
                message: `Job ${episodeCode} has been requeued`,
                position: result.position
            });
        } else {
            res.status(404).json({ error: `Failed job ${episodeCode} not found` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Retry all failed jobs
app.post('/failed-jobs/retry-all', async (_req, res) => {
    try {
        const results = smartQueue.retryAllFailed();
        let diskCount = 0;

        // Also process disk failures
        const files = await fs.readdir(FAILED_JOBS_DIR).catch(() => []);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
            try {
                const content = await fs.readFile(path.join(FAILED_JOBS_DIR, file), 'utf8');
                const job = JSON.parse(content);
                job.retryCount = 0;
                job.reelRetries = {};
                job.manualRetry = true;
                smartQueue.enqueue(job);
                await fs.unlink(path.join(FAILED_JOBS_DIR, file));
                diskCount++;
            } catch (e) {
                console.error(`[Failed Jobs] Error processing ${file}:`, e.message);
            }
        }

        const total = results.length + diskCount;

        io.emit('all-failed-requeued', { count: total });
        io.emit('log', {
            message: `تم إعادة ${total} وظيفة فاشلة للطابور`,
            type: 'success'
        });
        emitQueueUpdate();
        process.nextTick(processQueue);

        res.status(200).json({
            message: `${total} failed jobs have been requeued`,
            count: total
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a failed job
app.delete('/failed-jobs/:episodeCode', async (req, res) => {
    const { episodeCode } = req.params;

    try {
        // Remove from memory
        smartQueue.deleteFailedJob(episodeCode);

        // Remove from disk
        const files = await fs.readdir(FAILED_JOBS_DIR).catch(() => []);
        const matchingFile = files.find(f => f.includes(episodeCode) && f.endsWith('.json'));

        if (matchingFile) {
            await fs.unlink(path.join(FAILED_JOBS_DIR, matchingFile));
        }

        io.emit('failed-job-deleted', { episodeCode });
        io.emit('log', {
            message: `تم حذف الوظيفة الفاشلة: ${episodeCode}`,
            type: 'info'
        });
        emitQueueUpdate();

        res.status(200).json({
            message: `Failed job ${episodeCode} deleted`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health status endpoint
app.get('/health', async (_req, res) => {
    const premiereRunning = await isPremiereRunning();
    const isStuck = smartQueue.isStuck();

    res.status(200).json({
        status: isStuck ? 'degraded' : 'healthy',
        processing: isProcessing,
        queueLength: smartQueue.length,
        failedCount: smartQueue.failedJobs.size,
        premiere: {
            running: premiereRunning
        },
        lastProgressTime: smartQueue.lastProgressTime,
        stuckWarning: isStuck
    });
});

// Force restart Premiere Pro
app.post('/premiere/restart', async (_req, res) => {
    try {
        const success = await healthMonitor.restartPremiere();

        if (success) {
            res.status(200).json({
                message: 'Premiere Pro restarted successfully',
                status: 'restarted'
            });
        } else {
            res.status(500).json({
                error: 'Failed to restart Premiere Pro or on cooldown'
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cancel a job (queued or currently processing)
app.delete('/render/:episodeCode', async (req, res) => {
    const { episodeCode } = req.params;
    console.log(`[API /render] Cancel request for job: ${episodeCode}`);

    // Check if it's the currently processing job
    if (currentJob && currentJob.episodeCode === episodeCode) {
        jobCancelled = true;
        io.emit('log', {
            message: `جاري إلغاء الوظيفة: ${episodeCode}`,
            type: 'warning',
            details: 'سيتم إلغاء الوظيفة بعد اكتمال العملية الحالية'
        });
        io.emit('job-cancelling', { episodeCode });
        return res.status(200).json({
            message: `Job ${episodeCode} is being cancelled.`,
            status: 'cancelling'
        });
    }

    // Check if it's in the queue
    const jobIndex = smartQueue.findIndex(episodeCode);
    if (jobIndex !== -1) {
        const removedJob = smartQueue.removeAt(jobIndex);

        // Delete the job JSON file
        const jsonFilename = `job-${removedJob.episodeCode}-${removedJob.timestamp}.json`;
        const jsonFilePath = path.join(RENDER_JOBS_DIR, jsonFilename);
        await fs.unlink(jsonFilePath).catch(() => {});

        io.emit('job-cancelled', { job: removedJob });
        io.emit('log', {
            message: `تم إلغاء الوظيفة: ${episodeCode}`,
            type: 'success',
            details: 'تم إزالة الوظيفة من قائمة الانتظار'
        });
        emitQueueUpdate();

        return res.status(200).json({
            message: `Job ${episodeCode} has been cancelled and removed from queue.`,
            status: 'cancelled'
        });
    }

    return res.status(404).json({
        error: `Job ${episodeCode} not found in queue or currently processing.`
    });
});

app.post('/render', async (req, res) => {
    const job = req.body;
    if (!job || !job.episodeId || !job.reels) {
        return res.status(400).json({ error: "Invalid job payload. Missing episodeId or reels." });
    }

    console.log(`[API /render] Received new render job for episode ${job.episodeCode}. Adding to queue.`);

    // Ensure Premiere Pro is running
    await ensurePremiereRunning();

    try {
        await fs.mkdir(RENDER_JOBS_DIR, { recursive: true });
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        job.timestamp = timestamp;
        const jsonFilename = `job-${job.episodeCode}-${timestamp}.json`;
        const jsonFilePath = path.join(RENDER_JOBS_DIR, jsonFilename);

        await fs.writeFile(jsonFilePath, JSON.stringify(job, null, 2));
        console.log(`[Queue] Saved job JSON to ${jsonFilePath}`);

        const position = smartQueue.enqueue(job);
        console.log(`[Queue] Job added at position ${position} with priority ${job.priority}`);

        // Emit queue update to connected clients
        io.emit('log', {
            message: `وظيفة جديدة مضافة: ${job.episodeCode}`,
            type: 'info',
            details: `${job.reels.length} ريل - الموقع: ${position + 1}`
        });
        emitQueueUpdate();

        res.status(202).json({
            message: "Render job accepted and queued for processing.",
            position: position,
            priority: job.priority
        });
        process.nextTick(processQueue);
    } catch(e) {
        console.error(`[API /render] Failed to save job file:`, e);
        res.status(500).json({ error: "Failed to write job file to disk." });
    }
});

// --- WebSocket Connection Handler ---
io.on('connection', (socket) => {
    console.log('[WebSocket] Client connected:', socket.id);

    // Send current status on connection
    socket.emit('status-update', {
        queueLength: smartQueue.length,
        failedCount: smartQueue.failedJobs.size,
        isProcessing
    });

    emitQueueUpdate();

    // Send upload history
    socket.emit('upload-history-update', getUploadHistoryForClient());

    // Send failed jobs
    socket.emit('failed-jobs-update', { failedJobs: smartQueue.getFailedJobs() });

    socket.emit('log', {
        message: 'تم الاتصال بالخادم بنجاح',
        type: 'success'
    });

    // Handle status request
    socket.on('request-status', () => {
        socket.emit('status-update', {
            queueLength: smartQueue.length,
            failedCount: smartQueue.failedJobs.size,
            isProcessing
        });
        emitQueueUpdate();
    });

    // Handle ping for latency tracking
    socket.on('ping', () => {
        socket.emit('pong');
    });

    socket.on('disconnect', () => {
        console.log('[WebSocket] Client disconnected:', socket.id);
    });
});

// --- Load Failed Jobs from Disk ---
async function loadFailedJobsFromDisk() {
    try {
        const files = await fs.readdir(FAILED_JOBS_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        for (const file of jsonFiles) {
            try {
                const content = await fs.readFile(path.join(FAILED_JOBS_DIR, file), 'utf8');
                const job = JSON.parse(content);
                job.fromDisk = true;
                smartQueue.failedJobs.set(job.episodeCode, job);
            } catch (e) {
                console.error(`[Startup] Error loading failed job ${file}:`, e.message);
            }
        }

        if (jsonFiles.length > 0) {
            console.log(`[Startup] Loaded ${jsonFiles.length} failed jobs from disk`);
        }
    } catch (e) {
        // Directory might not exist - that's ok
    }
}

// --- Server Start ---
server.listen(PORT, '0.0.0.0', async () => {
    await setupWatcher();
    console.log(`[Server] Render V2 server listening on port ${PORT}`);
    console.log(`[Server] Dashboard available at: http://localhost:${PORT}`);
    console.log(`[Server] This server will save incoming JSON jobs and watch for .mp4 outputs.`);

    // Load failed jobs from disk
    await loadFailedJobsFromDisk();

    // Start health monitor
    healthMonitor.start();
    console.log('[Server] Health monitor started');

    // Start Premiere Pro if configured
    if (PREMIERE_CONFIG.autoStart) {
        console.log('[Server] Checking Adobe Premiere Pro...');
        await ensurePremiereRunning();
    }

    // Log configuration
    console.log(`[Server] Smart Queue Config: Max Retries=${JOB_RETRY_CONFIG.maxJobRetries}, Base Timeout=${JOB_RETRY_CONFIG.baseTimeout/60000}min`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] SIGINT received. Closing watcher and shutting down.');
    healthMonitor.stop();
    if (watcher) await watcher.close();
    io.close();
    process.exit(0);
});
