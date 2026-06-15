const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const moment = require('moment-timezone');
const axios = require('axios');
const AdmZip = require('adm-zip');
const mega = require('megajs');
require('dotenv').config();

const zipPath = 'bot.zip';
const extractPath = './';
const botFileName = 'cypher.js';
const RESTART_DELAY = 3000;
const TIMEZONE = 'Africa/Nairobi';
const MAX_RETRIES = 3;
const AXIOS_TIMEOUT = 9000;
let retryCount = 0;

const API_SERVERS = [
  { name: 'one', baseUrl: 'https://host.cypherxbot.space' },
  { name: 'two', baseUrl: 'https://live.cypherxbot.space' },
  { name: 'three', baseUrl: 'https://host.brevo.host' }
];

const API_PASSWORD = '********';
const BACKUP_ZIP_URL = 'https://qu.ax/NBd2x.zip';

let coreProcess = null;

const TELEGRAM_TOKEN = '7801027257:AAEjDgfhMVHs-QWdkFibAgBS4OgTRWOG5Jg';
const TELEGRAM_CHAT_ID = '7141254329';

const sendTelegramAlert = async (message) => {
 const text = `[CypherX Update Error]\n\n${message}`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    logMessage(`Telegram alert failed: ${e.message}`);
  }
};

function detectPlatform() {
  if (process.env.DYNO) return "Heroku";
  if (process.env.RENDER) return "Render";
  if (process.env.PREFIX && process.env.PREFIX.includes("termux")) return "Termux";
  if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return "CypherX Platform";
  if (process.env.P_SERVER_UUID) return "Panel";
  if (process.env.LXC) return "Linux Container (LXC)";
  
  switch (os.platform()) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

const allowedPlatforms = ["Heroku", "Render", "Termux", "Panel", "Windows", "CypherX Platform", "macOS"];
const currentPlatform = detectPlatform();

if (!allowedPlatforms.includes(currentPlatform)) {
  console.error(`🚫 Platform "${currentPlatform}" is not allowed! Crashing infinitely...`);
  const crashInfinitely = () => {
    setTimeout(() => {
      console.log("💥 Crashing again...");
      process.exit(1);
    }, 1000);
  };
  crashInfinitely();
  process.on('uncaughtException', crashInfinitely);
  process.on('unhandledRejection', crashInfinitely);
}

const envPath = path.join(__dirname, '.env');

if (!fs.existsSync(envPath)) {
  const platform = detectPlatform();
  if (platform === "Panel" || platform === "Termux") {
    const defaultSessionId = '';
    const envContent = `SESSION_ID=${defaultSessionId}\n`;
    fs.writeFileSync(envPath, envContent);
  }
}

function getLogFileName() {
    return `${moment().tz(TIMEZONE).format('YYYY-MM-DD')}.log`;
}

function createTmpFolder() {
    const folderPath = path.join(__dirname, 'tmp');
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
}

createTmpFolder();

function logMessage(message) {
    const timestamp = moment().tz(TIMEZONE).format('HH:mm z');
    console.log(`[CYPHER-X] ${message}`);
    fs.appendFileSync(path.join(__dirname, 'tmp', getLogFileName()), `[${timestamp}] ${message}\n`);
}

const DOWNLOAD_METHODS = [
  { name: '2', path: '/local-zip' },    
  { name: '1', path: '/latest-update' },
  { name: '3', path: '/latest-mega' }  
];

async function downloadFromMega(url) {
  return new Promise((resolve, reject) => {
    const file = mega.File.fromURL(url);
    file.loadAttributes((err) => {
      if (err) return reject(err);
      file.download((err, data) => {
        if (err) return reject(err);
        fs.writeFile(zipPath, data, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  });
}

async function tryDownloadFromServer(server, method) {
  try {
    const url = `${server.baseUrl}${method.path}?password=${API_PASSWORD}`;
    logMessage(`Trying method ${method.name} from server ${server.name}...`);

    if (method.name === '3' || method.name === '2') {
      if (method.name === '3') {
        const response = await axios.get(url, { timeout: AXIOS_TIMEOUT });
        if (response.data.status === 'success') {
          await downloadFromMega(response.data.latest);
          return { success: true, server: server.name, method: method.name };
        }
      } else { 
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          timeout: AXIOS_TIMEOUT
        });
        const writer = fs.createWriteStream(zipPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return { success: true, server: server.name, method: method.name };
      }
    } else { 
      const response = await axios.get(url, { timeout: AXIOS_TIMEOUT });
      if (response.data.status === 'success') {
        await downloadFile(response.data.latest, zipPath);
        return { success: true, server: server.name, method: method.name };
      }
    }
  } catch (err) {
    logMessage(`Failed method ${method.name} from server  ${server.name}: ${err.message}`);
   await sendTelegramAlert(`❌ Failed method ${method.name} from server ${server.name}\nReason: ${err.message}`);
    return { success: false };
  }
  return { success: false };
}

async function downloadWithFallback() {
  for (const method of DOWNLOAD_METHODS) {
    for (const server of API_SERVERS) {
      const result = await tryDownloadFromServer(server, method);
      if (result.success) {
        logMessage(`Successfully connected via method ${method.name} from server ${server.name}`);
        return;
      }
    }
    logMessage(`All servers failed for method ${method.name}`);
   await sendTelegramAlert(`🚨 All download methods for method ${method.name} failed on ${detectPlatform()}!`);
  }
  try {
    logMessage('Falling back to hardcoded backup');
    await downloadFile(BACKUP_ZIP_URL, zipPath);
  } catch (err) {
    throw new Error('All download methods including hardcoded fallback failed');
  }
}

async function downloadFile(url, dest) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: AXIOS_TIMEOUT
    });
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Download failed: ${error.message}`);
  }
}

const PRESERVE_PATHS = [
    './src/Database',
    './node_modules',
    './src/Session',
    './src/Session/creds.json.bak',
    './index.js',
    'config.js',
    './tmp',
    './.env',
    './app.json',
    './pnpm-lock.yaml',
    './package-lock.json',
    './yarn.lock'
];

const EXISTING_PRESERVE_PATHS = PRESERVE_PATHS.filter(p => fs.existsSync(p)).map(p => path.resolve(p));

const shouldPreserve = (filePath) => {
    const resolvedPath = path.resolve(filePath);
    return EXISTING_PRESERVE_PATHS.some(preservePath => resolvedPath.startsWith(preservePath));
};

async function extractZip(zipFile, outputPath) {
    try {
        logMessage('Processing...');
        const zip = new AdmZip(zipFile);
        const zipEntries = zip.getEntries();
        const getAllFiles = (dir, fileList = []) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (shouldPreserve(filePath)) return;
                if (stat.isDirectory()) {
                    getAllFiles(filePath, fileList);
                } else {
                    fileList.push(filePath);
                }
            });
            return fileList;
        };
        const allFiles = getAllFiles(outputPath);
        allFiles.forEach(filePath => {
            if (!shouldPreserve(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
        const getAllDirs = (dir, dirList = []) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                if (fs.statSync(filePath).isDirectory()) {
                    if (!shouldPreserve(filePath)) {
                        getAllDirs(filePath, dirList);
                        dirList.push(filePath);
                    }
                }
            });
            return dirList;
        };
        const allDirs = getAllDirs(outputPath);
        allDirs.sort((a, b) => b.length - a.length);
        allDirs.forEach(dirPath => {
            try {
                if (!shouldPreserve(dirPath)) {
                    fs.rmdirSync(dirPath);
                }
            } catch (e) {
            }
        });
        zipEntries.forEach((entry) => {
            const entryPath = path.join(outputPath, entry.entryName);
            if (shouldPreserve(entryPath)) return;
            const entryDir = path.dirname(entryPath);
            if (!fs.existsSync(entryDir)) {
                fs.mkdirSync(entryDir, { recursive: true });
            }
            if (!entry.isDirectory) {
                fs.writeFileSync(entryPath, zip.readFile(entry));
            } else {
                if (!fs.existsSync(entryPath)) {
                    fs.mkdirSync(entryPath, { recursive: true });
                }
            }
        });
        logMessage('Processed successfully.');
    } catch (error) {
        throw new Error(`Extraction failed: ${error.message}`);
    }
}

async function installDependencies() {

    return new Promise((resolve, reject) => {

        logMessage(
            'Installing dependencies...'
        );

        const env = {
            ...process.env,

            UV_THREADPOOL_SIZE: '1',

            npm_config_jobs: '1',
            npm_config_child_concurrency: '1',
            npm_config_maxsockets: '1',

            npm_config_fetch_retries: '1',

            npm_config_loglevel: 'error',

            npm_config_audit: 'false',
            npm_config_fund: 'false',
            npm_config_update_notifier: 'false',

            CI: 'true'
        };

        const install = spawn(
            'npm',
            [
                'install',

                '--no-audit',
                '--no-fund',
                '--no-progress',

                '--omit=dev',

                '--prefer-offline',

                '--foreground-scripts=false'
            ],
            {
                stdio: 'pipe',
                shell: false,
                env
            }
        );

        // silence npm warnings
        install.stderr.on(
            'data',
            (data) => {

                const text =
                    data.toString();

                if (
                    !text.includes('deprecated') &&
                    !text.includes('funding') &&
                    !text.includes('audit')
                ) {

                    process.stderr.write(text);

                }
            }
        );

        install.on(
            'close',
            (code) => {

                if (code !== 0) {

                    return reject(
                        new Error(
                            `Install failed with exit code ${code}`
                        )
                    );

                }

                logMessage(
                    'Dependencies installed successfully.'
                );

                resolve();

            }
        );

        install.on(
            'error',
            (err) => {

                reject(
                    new Error(
                        `Process error: ${err.message}`
                    )
                );

            }
        );

    });

}

function restoreAuthBackup() {
    const sessionDir = path.join(__dirname, 'src', 'Session');
    const bakFile = path.join(sessionDir, 'creds.json.bak');
    const credsFile = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(bakFile)) {
        logMessage('Restoring session from backup...');
        fs.copyFileSync(bakFile, credsFile);
    }
}

async function startBot(botFile) {
    return new Promise((resolve, reject) => {
        restoreAuthBackup();
        logMessage(`Starting ${retryCount + 1}/${MAX_RETRIES}...`);
        const logFilePath = path.join(__dirname, 'tmp', getLogFileName());
        const errorLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        coreProcess = spawn('node', [botFile], {
            stdio: ['inherit', 'inherit', 'pipe'],
            shell: true,
            windowsHide: true,
            env: {
                ...process.env,
                FORCE_COLOR: '3',
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor'
            }
        });
        coreProcess.stderr.on('data', (data) => {
            process.stderr.write(data);
            const cleanData = data.toString().replace(/\x1B\[[0-9;]*[mGK]/g, '');
            const timestamp = `[${moment().tz(TIMEZONE).format('HH:mm z')}] `;
            errorLogStream.write(timestamp + cleanData);
        });
const handleProcessExit = (code) => {
  errorLogStream.end();
  logMessage(`Bot process exited with code: ${code}`);

  // 🔐 AUTH RESET (silent)
  if (code === 10) {
    logMessage('Invalid Session detected. Resetting Database...');

    const sessionDir = path.join(__dirname, 'src', 'Session');
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      logMessage(`Session cleanup error: ${e.message}`);
    }

    retryCount = 0; // important: avoid retry exhaustion
    return setTimeout(main, RESTART_DELAY);
  }

  // ♻️ Normal crash / restart path
  handleRetry(code !== 0 ? new Error(`Bot process exited with code: ${code}`) : null);
};
        const handleProcessError = (err) => {
            errorLogStream.end();
            logMessage(`Bot process error: ${err.message}`);
            handleRetry(err);
        };
        coreProcess.on('close', handleProcessExit);
        coreProcess.on('error', handleProcessError);
        const handleShutdown = (signal) => {
            logMessage(`Shutting down CypherX due to ${signal}...`);
            coreProcess.kill();
            errorLogStream.end();
            process.exit(0);
        };
        process.on('SIGINT', handleShutdown);
        process.on('SIGTERM', handleShutdown);
        resolve(); 
    });
}

async function main() {
    try {
        await downloadWithFallback();
        await extractZip(zipPath, extractPath);
        await installDependencies();
        await startBot(botFileName);
        resetRetryCount(); 
    } catch (error) {
        logMessage(`Fatal error during initialization: ${error.message}`);
        handleRetry(error);
    }
}

function handleRetry(error) {
    if (error && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        logMessage(`Retrying (Attempt ${retryCount}/${MAX_RETRIES})...`);
        setTimeout(main, RESTART_DELAY);
    } else {
        if (error) {
            logMessage(`Max retries (${MAX_RETRIES}) reached. Exiting due to error: ${error.message}`);
        } else {
            logMessage(`Max retries (${MAX_RETRIES}) reached. Exiting.`);
        }
        process.exit(1);
    }
}

function resetRetryCount() {
    retryCount = 0;
}

main();
