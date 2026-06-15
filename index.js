const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const moment = require('moment-timezone');
const axios = require('axios');
const AdmZip = require('adm-zip');
const mega = require('megajs');
require('dotenv').config();

/**
 * =========================
 * SAFE ENVIRONMENT
 * =========================
 */

const SAFE_TMP = process.env.TMPDIR || '/tmp';
fs.mkdirSync(SAFE_TMP, { recursive: true });

const zipPath = path.join(SAFE_TMP, 'bot.zip');
const extractPath = process.cwd();
const botFileName = 'cypher.js';

const TIMEZONE = 'Africa/Nairobi';
const AXIOS_TIMEOUT = 15000;
const MAX_RETRIES = 5;
const RESTART_DELAY = 5000;

let retryCount = 0;
let botProcess = null;

/**
 * =========================
 * LOGGER
 * =========================
 */

const logDir = path.join(SAFE_TMP, 'cypher_logs');
fs.mkdirSync(logDir, { recursive: true });

function logFile() {
  return path.join(logDir, `${moment().tz(TIMEZONE).format('YYYY-MM-DD')}.log`);
}

function logMessage(msg) {
  const time = moment().tz(TIMEZONE).format('HH:mm:ss');
  const line = `[CYPHER-X] ${msg}`;

  console.log(line);
  fs.appendFileSync(logFile(), `[${time}] ${msg}\n`);
}

/**
 * =========================
 * PLATFORM (NO CRASH RULE)
 * =========================
 */

function detectPlatform() {
  if (process.env.RAILWAY_ENVIRONMENT) return 'Railway';
  if (process.env.RENDER) return 'Render';
  if (process.env.DYNO) return 'Heroku';

  switch (os.platform()) {
    case 'linux': return 'Linux';
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    default: return 'Unknown';
  }
}

logMessage(`Running on: ${detectPlatform()}`);

/**
 * =========================
 * CONFIG
 * =========================
 */

const API_SERVERS = [
  { name: 'one', baseUrl: 'https://host.cypherxbot.space' },
  { name: 'two', baseUrl: 'https://live.cypherxbot.space' },
  { name: 'three', baseUrl: 'https://host.brevo.host' }
];

const API_PASSWORD = process.env.API_PASSWORD || 'CHANGE_ME';
const BACKUP_ZIP_URL = 'https://qu.ax/NBd2x.zip';

/**
 * =========================
 * TELEGRAM (OPTIONAL SAFE)
 * =========================
 */

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chat) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat,
      text: `[CypherX]\n${message}`
    });
  } catch (e) {
    logMessage(`Telegram error: ${e.message}`);
  }
}

/**
 * =========================
 * DOWNLOAD ENGINE
 * =========================
 */

const METHODS = [
  { name: '2', path: '/local-zip' },
  { name: '1', path: '/latest-update' },
  { name: '3', path: '/latest-mega' }
];

async function downloadFile(url, dest) {
  const res = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: AXIOS_TIMEOUT
  });

  const writer = fs.createWriteStream(dest);

  res.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function downloadMega(url) {
  return new Promise((resolve, reject) => {
    const file = mega.File.fromURL(url);

    file.loadAttributes(err => {
      if (err) return reject(err);

      file.download((err, data) => {
        if (err) return reject(err);

        fs.writeFileSync(zipPath, data);
        resolve();
      });
    });
  });
}

async function tryDownload(server, method) {
  try {
    const url = `${server.baseUrl}${method.path}?password=${API_PASSWORD}`;

    logMessage(`Trying ${server.name} (${method.name})`);

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

    if (res.data?.status !== 'success') return false;

    const link = res.data.latest;

    if (method.name === '3') {
      await downloadMega(link);
    } else {
      await downloadFile(link, zipPath);
    }

    return true;

  } catch (err) {
    logMessage(`Fail ${server.name}/${method.name}: ${err.message}`);
    await sendTelegram(`Download fail: ${server.name}/${method.name}`);
    return false;
  }
}

async function downloadWithFallback() {
  for (const method of METHODS) {
    for (const server of API_SERVERS) {
      const ok = await tryDownload(server, method);
      if (ok) return logMessage('Download successful');
    }
  }

  logMessage('Fallback ZIP used');
  await downloadFile(BACKUP_ZIP_URL, zipPath);
}

/**
 * =========================
 * EXTRACT
 * =========================
 */

function extractZip() {
  logMessage('Extracting...');

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractPath, true);

  logMessage('Extraction complete');
}

/**
 * =========================
 * START BOT
 * =========================
 */

function startBot() {
  return new Promise((resolve, reject) => {
    logMessage(`Starting bot attempt ${retryCount + 1}`);

    botProcess = spawn('node', [botFileName], {
      stdio: 'inherit',
      shell: false,
      env: process.env
    });

    botProcess.on('close', (code) => {
      logMessage(`Bot exited: ${code}`);

      if (code === 0) return resolve();

      if (retryCount < MAX_RETRIES) {
        retryCount++;
        logMessage(`Restarting bot... (${retryCount}/${MAX_RETRIES})`);

        setTimeout(() => {
          startBot().then(resolve).catch(reject);
        }, RESTART_DELAY);

      } else {
        reject(new Error('Max retries reached'));
      }
    });

    botProcess.on('error', reject);
  });
}

/**
 * =========================
 * MAIN
 * =========================
 */

async function main() {
  try {
    await downloadWithFallback();
    extractZip();
    await startBot();

    retryCount = 0;

  } catch (err) {
    logMessage(`Fatal: ${err.message}`);

    if (retryCount < MAX_RETRIES) {
      retryCount++;
      setTimeout(main, RESTART_DELAY);
    } else {
      process.exit(1);
    }
  }
}

/**
 * =========================
 * SAFETY (NO CRASH SPIRAL)
 * =========================
 */

process.on('uncaughtException', (err) => {
  logMessage(`Uncaught: ${err.message}`);
});

process.on('unhandledRejection', (err) => {
  logMessage(`Unhandled: ${err?.message || err}`);
});

/**
 * =========================
 * BOOT
 * =========================
 */

main();
