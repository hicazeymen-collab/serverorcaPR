
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

// --- Premiere Pro Configuration ---
const PREMIERE_CONFIG = {
    // Default Premiere Pro paths (will check both)
    exePaths: [
        process.env.PREMIERE_EXE_PATH,
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
        exec('tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /NH', (error, stdout) => {
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

// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000  // 10 seconds max
};

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
const jobQueue = [];
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
    if (isProcessing || jobQueue.length === 0) {
        return;
    }
    isProcessing = true;
    jobCancelled = false; // Reset cancellation flag
    const job = jobQueue.shift();
    currentJob = job; // Track current job for cancellation
    const { episodeId, reels, podcastCode, episodeCode } = job;

    console.log(`[Queue] Starting processing for job: ${episodeCode}`);

    // Emit job started event
    io.emit('job-started', job);
    io.emit('log', {
        message: `بدء معالجة الوظيفة: ${episodeCode}`,
        type: 'info',
        details: `${reels.length} ريل في قائمة الانتظار`
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

    const jobTimeout = setTimeout(() => {
         console.error(`[Job Timeout] Job for ${episodeCode} timed out after 30 minutes.`);
         watcher?.off('add', onFileAdd);
         reels.forEach((reel) => {
             if (!processedReelIds.has(reel.id)) {
                 notifyApp(episodeId, reel.id, 'failed', null, 100, "Render job timed out on the server.");
             }
         });
         io.emit('log', {
             message: `انتهت مهلة الوظيفة: ${episodeCode}`,
             type: 'error',
             details: 'تم تجاوز 30 دقيقة'
         });
         reelProgressMap.delete(progressKey);
         currentJob = null;
         isProcessing = false;
         emitQueueUpdate();
         process.nextTick(processQueue);
    }, 30 * 60 * 1000);

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
    const queueWithProgress = jobQueue.map((job, index) => {
        if (index === 0 && isProcessing) {
            // Add progress data to the currently processing job
            const progress = reelProgressMap.get(job.episodeCode);
            return { ...job, reelProgress: progress };
        }
        return job;
    });

    io.emit('queue-update', queueWithProgress);
    io.emit('status-update', {
        queueLength: jobQueue.length,
        isProcessing
    });
}


// --- Express Routes ---
app.get('/status', async (_req, res) => {
    const premiereRunning = await isPremiereRunning();
    res.status(200).json({
        status: 'ok',
        message: `Render V2 server is running.`,
        queueLength: jobQueue.length,
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

app.post('/premiere/start', async (_req, res) => {
    const isRunning = await isPremiereRunning();

    if (isRunning) {
        return res.status(200).json({
            message: 'Adobe Premiere Pro is already running.',
            status: 'already_running'
        });
    }

    const started = await startPremiere();

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
    const jobIndex = jobQueue.findIndex(j => j.episodeCode === episodeCode);
    if (jobIndex !== -1) {
        const removedJob = jobQueue.splice(jobIndex, 1)[0];

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

        jobQueue.push(job);

        // Emit queue update to connected clients
        io.emit('log', {
            message: `وظيفة جديدة مضافة: ${job.episodeCode}`,
            type: 'info',
            details: `${job.reels.length} ريل في الطلب`
        });
        emitQueueUpdate();

        res.status(202).json({ message: "Render job accepted and queued for processing." });
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
        queueLength: jobQueue.length,
        isProcessing
    });

    emitQueueUpdate();

    // Send upload history
    socket.emit('upload-history-update', getUploadHistoryForClient());

    socket.emit('log', {
        message: 'تم الاتصال بالخادم بنجاح',
        type: 'success'
    });

    // Handle status request
    socket.on('request-status', () => {
        socket.emit('status-update', {
            queueLength: jobQueue.length,
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

// --- Server Start ---
server.listen(PORT, '0.0.0.0', async () => {
    await setupWatcher();
    console.log(`[Server] Render V2 server listening on port ${PORT}`);
    console.log(`[Server] Dashboard available at: http://localhost:${PORT}`);
    console.log(`[Server] This server will save incoming JSON jobs and watch for .mp4 outputs.`);

    // Start Premiere Pro if configured
    if (PREMIERE_CONFIG.autoStart) {
        console.log('[Server] Checking Adobe Premiere Pro...');
        await ensurePremiereRunning();
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] SIGINT received. Closing watcher and shutting down.');
    if (watcher) await watcher.close();
    io.close();
    process.exit(0);
});
