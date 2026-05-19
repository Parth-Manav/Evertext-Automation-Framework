/**
 * @module db
 * @description Encrypted lowdb storage module for credentials and settings.
 * Features an atomic write mechanism, in-memory caching for performance,
 * and seamless transparent AES encryption for restore codes.
 */

import { JSONFilePreset } from 'lowdb/node';
import CryptoJS from 'crypto-js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { AsyncLock } from './async-lock.js';
import { createLogger } from './logger.js';
import { ValidationError } from './errors.js';
import { ACCOUNT_STATUS } from './constants.js';

dotenv.config();

const logger = createLogger('db');
const dbLock = new AsyncLock();

const defaultData = { accounts: [], settings: { scheduleStart: '10:00', scheduleEnd: '20:00', lastResetDate: '' } };
const db = await JSONFilePreset('db.json', defaultData);

let SECRET_KEY = process.env.ENCRYPTION_KEY;
if (!SECRET_KEY || SECRET_KEY === 'default_secret_please_change') {
  SECRET_KEY = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
  try {
    const envContent = `\nENCRYPTION_KEY=${SECRET_KEY}\n`;
    await fs.appendFile('.env', envContent);
    logger.warn('Generated and saved a new secure ENCRYPTION_KEY to .env');
  } catch (err) {
    logger.error('Failed to write ENCRYPTION_KEY to .env', err);
  }
}

// In-memory cache to reduce file reads
let dbCache = null;
let lastRead = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Helper to get cached data to avoid excessive file reads.
 * @returns {Promise<Object>} Deep clone of the cached database data.
 */
const getCachedData = async () => {
  const now = Date.now();
  if (!dbCache || (now - lastRead) > CACHE_TTL) {
    await db.read();
    dbCache = JSON.parse(JSON.stringify(db.data)); // Deep clone
    lastRead = now;
  }
  return dbCache;
};

/**
 * Helper to write data atomically to disk and invalidate the cache.
 * Uses a temp file and rename strategy to prevent data corruption.
 * @returns {Promise<void>}
 */
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
    logger.error('Atomic write failed:', err);
    // Cleanup temp file if it exists
    try { await fs.unlink(tempPath); } catch { }
    throw err;
  }
};

/**
 * Encrypts a string using AES symmetric encryption.
 * @param {string} text - The plaintext to encrypt.
 * @returns {string} The base64-like encrypted string.
 */
export const encrypt = (text) => {
  return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
};

/**
 * Decrypts an AES encrypted string.
 * @param {string} ciphertext - The encrypted string.
 * @returns {string} The decrypted plaintext.
 */
export const decrypt = (ciphertext) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
};

/**
 * Checks if a string appears to be encrypted.
 * @param {string} text - The string to check.
 * @returns {boolean} True if the string decrypts properly.
 */
export const isEncrypted = (text) => {
  try {
    const bytes = CryptoJS.AES.decrypt(text, SECRET_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted.length > 0 && text !== decrypted;
  } catch (e) {
    return false;
  }
};

/**
 * Scans the database and encrypts any plain-text restore codes.
 * @returns {Promise<number>} Number of accounts migrated.
 */
export const migrateUnencryptedCodes = async () => {
  const release = await dbLock.acquire();
  try {
    await db.read();
    let migratedCount = 0;

  for (const account of db.data.accounts) {
    if (!isEncrypted(account.encryptedCode)) {
      logger.info(`Migrating plain-text code for account: ${account.name}`);
      account.encryptedCode = encrypt(account.encryptedCode);
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    await writeAndInvalidate();
    logger.info(`Migration complete. Encrypted ${migratedCount} account(s).`);
  } else {
    logger.debug('No migration needed. All codes are encrypted.');
  }

  release();
  return migratedCount;
  } catch(e) { release(); throw e; }
};

/**
 * Adds or updates an account in the database.
 * @param {string} name - Account display name.
 * @param {string} encryptedCode - AES encrypted restore code.
 * @param {string} targetServer - Target game server.
 * @param {boolean} [serverToggle=true] - Whether to use the server selection flow.
 * @returns {Promise<boolean>} True if successful.
 */
export const addAccount = async (name, encryptedCode, targetServer, serverToggle = true) => {
  if (!name?.trim()) throw new ValidationError('Account name cannot be empty');
  if (!encryptedCode?.trim()) throw new ValidationError('Encrypted code cannot be empty');
  if (!targetServer?.trim()) throw new ValidationError('Target server cannot be empty');

  const release = await dbLock.acquire();
  try {
    await db.read();

  // Prevent duplicate names
  if (db.data.accounts.find(acc => acc.name === name)) {
    // Overwrite existing
    const index = db.data.accounts.findIndex(acc => acc.name === name);
    db.data.accounts[index] = {
      ...db.data.accounts[index],
      encryptedCode,
      targetServer,
      serverToggle,
      status: ACCOUNT_STATUS.PENDING
    };
  } else {
    db.data.accounts.push({
      id: Date.now().toString(),
      name,
      encryptedCode,
      targetServer,
      serverToggle,
      lastRun: null,
      status: ACCOUNT_STATUS.PENDING
    });
  }

  await writeAndInvalidate();
  release();
  return true;
  } catch(e) { release(); throw e; }
};

/**
 * Retrieves all accounts from the database.
 * @returns {Promise<Array<import('./types.js').Account>>} List of accounts.
 */
export const getAccounts = async () => {
  const data = await getCachedData();
  return data.accounts;
};

/**
 * Removes an account by name.
 * @param {string} name - Account name to remove.
 * @returns {Promise<boolean>} True if removed, false if not found.
 */
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

/**
 * Updates the processing status of a specific account.
 * @param {string} id - The account ID.
 * @param {import('./constants.js').ACCOUNT_STATUS} status - The new status.
 * @param {string} [lastRun=null] - Optional timestamp of completion.
 * @returns {Promise<void>}
 */
export const updateAccountStatus = async (id, status, lastRun = null) => {
  if (!id?.trim()) throw new ValidationError('Account id cannot be empty');
  const validStatuses = Object.values(ACCOUNT_STATUS);
  if (!validStatuses.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

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

/**
 * Retrieves a single account and decrypts its restore code.
 * @param {string} id - The account ID.
 * @returns {Promise<import('./types.js').Account & {code: string}>} Account object with decrypted `code`.
 * @throws {Error} If account not found.
 */
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

/**
 * Gets the configured active hours.
 * @returns {Promise<{scheduleStart: string, scheduleEnd: string}>}
 */
export const getSchedule = async () => {
  const data = await getCachedData();
  return data.settings || { scheduleStart: '10:00', scheduleEnd: '20:00' };
};

/**
 * Sets the active hours.
 * @param {string} start - Start hour (HH:00).
 * @param {string} end - End hour (HH:00).
 * @returns {Promise<Object>}
 */
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

/**
 * Sets the global session cookie, encrypting it if it isn't already.
 * @param {string} cookies - The cookie string.
 * @returns {Promise<boolean>}
 */
export const setCookies = async (cookies) => {
  const release = await dbLock.acquire();
  try {
    await db.read();

  let encryptedCookies;
  if (isEncrypted(cookies)) {
    logger.debug('Cookies appear to be already encrypted, using as-is');
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

/**
 * Retrieves the configured Discord Admin Role ID.
 * @returns {Promise<string|null>}
 */
export const getAdminRole = async () => {
  const data = await getCachedData();
  return data.settings?.adminRoleId || null;
};

/**
 * Sets the configured Discord Admin Role ID.
 * @param {string} roleId - The Discord role ID.
 * @returns {Promise<boolean>}
 */
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

/**
 * Retrieves the configured Discord Log Channel ID.
 * @returns {Promise<string|null>}
 */
export const getLogChannel = async () => {
  const data = await getCachedData();
  return data.settings?.logChannelId || null;
};

/**
 * Sets the configured Discord Log Channel ID.
 * @param {string} channelId - The Discord channel ID.
 * @returns {Promise<boolean>}
 */
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

/**
 * Resets all account statuses to "pending". Used for daily resets.
 * @returns {Promise<void>}
 */
export const resetAllStatuses = async () => {
  const release = await dbLock.acquire();
  try {
    await db.read();
  for (const account of db.data.accounts) {
    account.status = 'pending';
  }
  await writeAndInvalidate();
  logger.info('All account statuses reset to pending');
  release();
  } catch(e) { release(); throw e; }
};

/**
 * Resets the status of any non-completed account to "pending".
 * @returns {Promise<number>} Number of accounts reset.
 */
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
  logger.info(`Reset ${count} non-done statuses to pending`);
  release();
  return count;
  } catch(e) { release(); throw e; }
};

/**
 * Retrieves and decrypts the global session cookie.
 * @returns {Promise<string|null>}
 */
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
    const decrypted = decrypt(cookies);
    if (!decrypted || decrypted.length === 0) {
      logger.warn('Cookie decryption failed (empty result). Returning null.');
      return null;
    }
    return decrypted;
  } catch (e) {
    if (isEncrypted(cookies)) {
      logger.warn('Cookie decryption failed. Returning null.');
      return null; // Don't return garbage
    }
    return cookies; // Legacy fallback
  }
};

// Run migration on module load to fix any existing plain-text codes
await migrateUnencryptedCodes();

/**
 * Gets the timestamp string of the last daily reset.
 * @returns {Promise<string>}
 */
export const getLastResetDate = async () => {
  const data = await getCachedData();
  return data.settings?.lastResetDate || '';
};

/**
 * Records the timestamp of the last daily reset.
 * @param {string} dateStr - Date string (YYYY-MM-DD).
 * @returns {Promise<boolean>}
 */
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
