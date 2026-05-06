import { JSONFilePreset } from 'lowdb/node';
import CryptoJS from 'crypto-js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { AsyncLock } from './async-lock.js';

dotenv.config();

const dbLock = new AsyncLock();

const defaultData = { accounts: [], settings: { scheduleStart: '10:00', scheduleEnd: '20:00', lastResetDate: '' } };
const db = await JSONFilePreset('db.json', defaultData);

let SECRET_KEY = process.env.ENCRYPTION_KEY;
if (!SECRET_KEY || SECRET_KEY === 'default_secret_please_change') {
  SECRET_KEY = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
  try {
    const envContent = `\nENCRYPTION_KEY=${SECRET_KEY}\n`;
    await fs.appendFile('.env', envContent);
    console.log('[DB] ⚠️ Generated and saved a new secure ENCRYPTION_KEY to .env');
  } catch (err) {
    console.error('[DB] ❌ Failed to write ENCRYPTION_KEY to .env', err);
  }
}

// In-memory cache to reduce file reads (Issue #27 fix)
let dbCache = null;
let lastRead = 0;
const CACHE_TTL = 5000; // 5 seconds

// Helper to get cached data
const getCachedData = async () => {
  const now = Date.now();
  if (!dbCache || (now - lastRead) > CACHE_TTL) {
    await db.read();
    dbCache = JSON.parse(JSON.stringify(db.data)); // Deep clone
    lastRead = now;
  }
  return dbCache;
};

// Helper to invalidate cache after write
// NOW ATOMIC: Writes to temp file first, then renames
const writeAndInvalidate = async () => {
  const dbPath = 'db.json';
  const tempPath = 'db.json.tmp';
  const backupPath = 'db.json.backup';

  try {
    // 0. Backup (optional but good)
    try {
      await fs.copyFile(dbPath, backupPath);
    } catch (e) { /* First run, no backup */ }

    // 1. Write to temp file
    await fs.writeFile(tempPath, JSON.stringify(db.data, null, 2));

    // 2. Atomic rename (replaces old file)
    await fs.rename(tempPath, dbPath);

    // 3. Invalidate cache
    dbCache = null;
  } catch (err) {
    console.error('[DB] Atomic write failed:', err);
    // Cleanup temp file if it exists
    try { await fs.unlink(tempPath); } catch { }
    throw err;
  }
};

export const encrypt = (text) => {
  return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
};

export const decrypt = (ciphertext) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
};

export const isEncrypted = (text) => {
  // Check if text looks like encrypted data (AES encrypted strings contain special characters)
  // A simple heuristic: encrypted text from CryptoJS.AES is base64-like and contains '==' or special chars
  try {
    const bytes = CryptoJS.AES.decrypt(text, SECRET_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    // If decryption produces valid UTF-8 and the original doesn't match (i.e., it was encrypted), return true
    // If it fails or produces empty string, it's likely not encrypted
    return decrypted.length > 0 && text !== decrypted;
  } catch (e) {
    return false;
  }
};

export const migrateUnencryptedCodes = async () => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    let migratedCount = 0;

  for (const account of db.data.accounts) {
    if (!isEncrypted(account.encryptedCode)) {
      console.log(`[DB] Migrating plain-text code for account: ${account.name}`);
      account.encryptedCode = encrypt(account.encryptedCode);
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    await writeAndInvalidate();
    console.log(`[DB] Migration complete. Encrypted ${migratedCount} account(s).`);
  } else {
    console.log('[DB] No migration needed. All codes are encrypted.');
  }

  release();
  return migratedCount;
  } catch(e) { release(); throw e; }
};

export const addAccount = async (name, encryptedCode, targetServer, serverToggle = true) => {
  const release = await dbLock.acquire();
  try {
    await db.read();

  // Prevent duplicate names
  if (db.data.accounts.find(acc => acc.name === name)) {
    // Overwrite existing? Or throw error? For now, overwrite
    const index = db.data.accounts.findIndex(acc => acc.name === name);
    db.data.accounts[index] = {
      ...db.data.accounts[index],
      encryptedCode,
      targetServer,
      serverToggle, // Save the toggle
      status: 'pending' // Reset status on update
    };
  } else {
    db.data.accounts.push({
      id: Date.now().toString(),
      name,
      encryptedCode,
      targetServer,
      serverToggle, // Save the toggle
      lastRun: null,
      status: 'pending'
    });
  }

  await writeAndInvalidate();
  release();
  return true;
  } catch(e) { release(); throw e; }
};

export const getAccounts = async () => {
  const data = await getCachedData();
  return data.accounts;
};

export const removeAccount = async (name) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    const initialLength = db.data.accounts.length;
  db.data.accounts = db.data.accounts.filter(a => a.name !== name);
  await writeAndInvalidate();
  release();
  return db.data.accounts.length < initialLength;
  } catch(e) { release(); throw e; }
};

export const updateAccountStatus = async (id, status, lastRun = null) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
  const account = db.data.accounts.find(a => a.id === id);
  if (account) {
    account.status = status;
    if (lastRun) account.lastRun = lastRun;
    await writeAndInvalidate();
  }
  release();
  } catch(e) { release(); throw e; }
};

export const getAccountDecrypted = async (id) => {
  await db.read();
  const account = db.data.accounts.find(a => a.id === id);
  if (!account) {
    throw new Error(`Account with ID ${id} not found`);
  }
  return {
    ...account,
    code: decrypt(account.encryptedCode)
  };
};

export const getSchedule = async () => {
  const data = await getCachedData();
  return data.settings || { scheduleStart: '10:00', scheduleEnd: '20:00' };
};

export const setSchedule = async (start, end) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    db.data.settings = { ...db.data.settings, scheduleStart: start, scheduleEnd: end };
  await writeAndInvalidate();
  release();
  return db.data.settings;
  } catch(e) { release(); throw e; }
};

export const setCookies = async (cookies) => {
  const release = await dbLock.acquire();
  try {
    await db.read();

  // Check if already encrypted to prevent double encryption
  let encryptedCookies;
  if (isEncrypted(cookies)) {
    console.log('[DB] Cookies appear to be already encrypted, using as-is');
    encryptedCookies = cookies;
  } else {
    encryptedCookies = encrypt(cookies);
  }

  db.data.settings = { ...db.data.settings, cookies: encryptedCookies };
  await writeAndInvalidate();
  release();
  return true;
  } catch(e) { release(); throw e; }
};

export const getAdminRole = async () => {
  const data = await getCachedData();
  return data.settings?.adminRoleId || null;
};

export const setAdminRole = async (roleId) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    db.data.settings = { ...db.data.settings, adminRoleId: roleId };
  await writeAndInvalidate();
  release();
  return true;
  } catch(e) { release(); throw e; }
};

export const getLogChannel = async () => {
  const data = await getCachedData();
  return data.settings?.logChannelId || null;
};

export const setLogChannel = async (channelId) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    db.data.settings = { ...db.data.settings, logChannelId: channelId };
  await writeAndInvalidate();
  release();
  return true;
  } catch(e) { release(); throw e; }
};

export const resetAllStatuses = async () => {
  const release = await dbLock.acquire();
  try {
    await db.read();
  for (const account of db.data.accounts) {
    account.status = 'pending';
  }
  await writeAndInvalidate();
  console.log('[DB] All account statuses reset to pending');
  release(); // Added release
  } catch(e) { release(); throw e; } // Added release
};

export const resetErrorStatuses = async () => {
  const release = await dbLock.acquire();
  try {
    await db.read();
  let count = 0;
  for (const account of db.data.accounts) {
    if (account.status !== 'done' && account.status !== 'pending') {
      account.status = 'pending';
      count++;
    }
  }
  if (count > 0) {
    await writeAndInvalidate();
  }
  console.log(`[DB] Reset ${count} non-done statuses to pending`);
  release();
  return count;
  } catch(e) { release(); throw e; }
};

export const getCookies = async () => {
  const release = await dbLock.acquire();
  let cookies;
  try {
    await db.read();
    cookies = db.data.settings?.cookies;
  } catch(e) {
    release();
    throw e;
  }
  release();

  if (!cookies) return null;

  try {
    // Attempt to decrypt
    const decrypted = decrypt(cookies);
    if (!decrypted || decrypted.length === 0) {
      console.warn('[DB] Cookie decryption failed (empty result). Returning null.');
      return null;
    }
    return decrypted;
  } catch (e) {
    if (isEncrypted(cookies)) {
      console.warn('[DB] Cookie decryption failed. Returning null.');
      return null; // Don't return garbage
    }
    return cookies; // Legacy fallback
  }
};

// Run migration on module load to fix any existing plain-text codes
await migrateUnencryptedCodes();

export const getLastResetDate = async () => {
  const data = await getCachedData();
  return data.settings?.lastResetDate || '';
};

export const setLastResetDate = async (dateStr) => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    db.data.settings = { ...db.data.settings, lastResetDate: dateStr };
    await writeAndInvalidate();
    release();
    return true;
  } catch(e) { release(); throw e; }
};

export { db };
