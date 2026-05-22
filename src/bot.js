/**
 * @module bot
 * @description Discord.js bot controller for the hybrid terminal automation framework.
 * Handles slash command registration, permission checks, user interactions,
 * and sending formatted log messages to the configured Discord channel.
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { addAccount, getAccounts, removeAccount, encrypt, setSchedule, setCookies, getAdminRole, setAdminRole, resetAllStatuses, resetErrorStatuses, getLogChannel, setLogChannel } from './db.js';
import { executeSession, runBatch, forceStop } from './manager.js';
import { createLogger } from './logger.js';
import { ValidationError } from './errors.js';

dotenv.config();

const logger = createLogger('bot');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const MAX_ACCOUNT_NAME_LENGTH = 64;
const MAX_RESTORE_CODE_LENGTH = 512;
const MAX_SERVER_NAME_LENGTH = 64;
const MAX_COOKIE_LENGTH = 8_192;

function requireTrimmedString(value, label, maxLength) {
    const trimmed = value?.trim();
    if (!trimmed) {
        throw new ValidationError(`${label} cannot be empty.`);
    }
    if (trimmed.length > maxLength) {
        throw new ValidationError(`${label} must be ${maxLength} characters or less.`);
    }
    return trimmed;
}

function normalizeAccountName(name) {
    return name.trim().toLowerCase();
}

const commands = [
    new SlashCommandBuilder()
        .setName('add_account')
        .setDescription('Add a terminal workflow account')
        .addStringOption(option => option.setName('name').setDescription('Account Name').setRequired(true))
        .addStringOption(option => option.setName('code').setDescription('Restore Code').setRequired(true))
        .addBooleanOption(option => option.setName('server_toggle').setDescription('Enable Server Selection? (True=Select, False=Skip)').setRequired(true))
        .addStringOption(option => option.setName('server').setDescription('Target Server (e.g., E-15, All) - Required if Toggle is True').setRequired(false)),
    new SlashCommandBuilder()
        .setName('list_accounts')
        .setDescription('List all configured accounts'),
    new SlashCommandBuilder()
        .setName('force_run')
        .setDescription('Force run your account(s)')
        .addStringOption(option => option.setName('name').setDescription('Account Name (leave empty for all yours)').setRequired(false)),
    new SlashCommandBuilder()
        .setName('force_run_all')
        .setDescription('[ADMIN] Run ALL accounts in the database'),
    new SlashCommandBuilder()
        .setName('force_stop_all')
        .setDescription('[ADMIN] Emergency kill-switch to stop all processes'),
    new SlashCommandBuilder()
        .setName('remove_account')
        .setDescription('Remove a terminal workflow account')
        .addStringOption(option => option.setName('name').setDescription('Account Name to remove').setRequired(true)),
    new SlashCommandBuilder()
        .setName('set_schedule')
        .setDescription('[ADMIN] Set the active hours for the bot')
        .addIntegerOption(option => option.setName('start_hour').setDescription('Start Hour (0-23)').setRequired(true))
        .addIntegerOption(option => option.setName('end_hour').setDescription('End Hour (0-23)').setRequired(true)),
    new SlashCommandBuilder()
        .setName('set_cookies')
        .setDescription('[ADMIN] Updates the global session cookie')
        .addStringOption(option => option.setName('cookies').setDescription('Paste cookie string (key=value; ...) or JSON').setRequired(true)),
    new SlashCommandBuilder()
        .setName('force_run_again_all')
        .setDescription('Reset all accounts to pending and run them immediately (Admin Only)'),
    new SlashCommandBuilder()
        .setName('force_run_error_all_again')
        .setDescription('Reset and run all accounts that are not "done" (Admin Only)'),
    new SlashCommandBuilder()
        .setName('set_admin_role')
        .setDescription('Set the role that can manage the bot')
        .addRoleOption(option => option.setName('role').setDescription('Select Admin Role').setRequired(true)),
    new SlashCommandBuilder()
        .setName('set_log_channel')
        .setDescription('[ADMIN] Set the channel for bot logs')
        .addChannelOption(option => option.setName('channel').setDescription('Log Channel').setRequired(true)),
    new SlashCommandBuilder()
        .setName('mute_bot')
        .setDescription('[ADMIN] Mute automatic bot messages'),
    new SlashCommandBuilder()
        .setName('unmute_bot')
        .setDescription('[ADMIN] Unmute automatic bot messages'),
];

client.once('ready', async () => {
    logger.info(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        logger.info('Refreshing application (/) commands.');
        // If GUILD_ID is set and not the placeholder, register to guild
        if (process.env.GUILD_ID && process.env.GUILD_ID !== 'your_guild_id_here') {
            await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
        } else {
            logger.info('Registering global commands (this may take a while to update)...');
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        }
        logger.info('Successfully reloaded application (/) commands.');
    } catch (error) {
        logger.error('Failed to reload application (/) commands', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        // --- Permission Check ---
        const sensitiveCommands = ['add_account', 'remove_account', 'set_schedule', 'set_cookies', 'force_run_again_all', 'force_run_error_all_again', 'force_run_all', 'force_stop_all', 'set_admin_role', 'set_log_channel', 'mute_bot', 'unmute_bot', 'force_run', 'list_accounts'];
        if (sensitiveCommands.includes(commandName)) {
            const adminRoleId = await getAdminRole();
            const hasAdminRole = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
            const isDiscordAdmin = interaction.memberPermissions.has('Administrator');

            if (!hasAdminRole && !isDiscordAdmin) {
                await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
                return;
            }
        }

        if (commandName === 'add_account') {
            const name = requireTrimmedString(interaction.options.getString('name'), 'Account name', MAX_ACCOUNT_NAME_LENGTH);
            const code = requireTrimmedString(interaction.options.getString('code'), 'Restore code', MAX_RESTORE_CODE_LENGTH);
            const serverToggle = interaction.options.getBoolean('server_toggle');
            let server = interaction.options.getString('server')?.trim();

            // Logic Validation
            if (serverToggle && !server) {
                await interaction.reply({ content: '❌ **Error**: You set `Server Selection: True`, so you MUST provide a `Target Server`!', ephemeral: true });
                return;
            }

            // Default server string if skipping
            if (!server) server = 'Auto-Skip';
            server = requireTrimmedString(server, 'Target server', MAX_SERVER_NAME_LENGTH);

            // Encrypt the code before storing
            const encryptedCode = encrypt(code);
            await addAccount(name, encryptedCode, server, serverToggle);
            await interaction.reply({ content: `✅ Account **${name.trim()}** added!\nServer Selection: **${serverToggle ? 'Enabled' : 'Disabled'}**\nTarget: ${server.trim()}`, ephemeral: true });
        }
        else if (commandName === 'list_accounts') {
            const accounts = await getAccounts();
            if (accounts.length === 0) {
                await interaction.reply('No accounts configured.');
                return;
            }

            const accountStrings = accounts.map(a =>
                `**${a.name}** (Server: ${a.targetServer})\nStatus: ${a.status}\nLast Run: ${a.lastRun ? new Date(a.lastRun).toLocaleString() : 'Never'}`
            );

            const embeds = [];
            let currentDesc = '';

            for (const str of accountStrings) {
                if (currentDesc.length + str.length + 4 > 4000) {
                    embeds.push(new EmbedBuilder()
                        .setTitle(embeds.length === 0 ? 'Configured Accounts' : 'Configured Accounts (Cont.)')
                        .setDescription(currentDesc)
                        .setColor(0x0099FF));
                    currentDesc = str;
                } else {
                    currentDesc += (currentDesc ? '\n\n' : '') + str;
                }
            }
            if (currentDesc) {
                embeds.push(new EmbedBuilder()
                    .setTitle(embeds.length === 0 ? 'Configured Accounts' : 'Configured Accounts (Cont.)')
                    .setDescription(currentDesc)
                    .setColor(0x0099FF));
            }

            if (embeds.length <= 10) {
                await interaction.reply({ embeds });
            } else {
                await interaction.reply({ embeds: embeds.slice(0, 10) });
                for (let i = 10; i < embeds.length; i += 10) {
                    await interaction.followUp({ embeds: embeds.slice(i, i + 10) });
                }
            }
        }
        else if (commandName === 'force_run') {
            const name = interaction.options.getString('name')?.trim();
            const accounts = await getAccounts();

            if (!name) {
                // Run all user's accounts (future enhancement - for now just error)
                await interaction.reply({ content: 'Please specify an account name.', ephemeral: true });
                return;
            }

            if (name.toLowerCase() === 'all') {
                await interaction.reply(`Starting batch session for **ALL** accounts... Check console/logs for progress.`);
                runBatch(accounts).then(() => {
                    interaction.followUp(`Batch session for **ALL** accounts finished.`).catch(err => logger.error('FollowUp error:', err));
                }).catch(err => {
                    logger.error('Batch run error:', err);
                    interaction.followUp(`❌ Batch run encountered an error: ${err.message}`).catch(err => logger.error('FollowUp error:', err));
                });
                return;
            }

            const account = accounts.find(a => normalizeAccountName(a.name) === normalizeAccountName(name));

            if (!account) {
                await interaction.reply({ content: `Account **${name}** not found.`, ephemeral: true });
                return;
            }

            await interaction.reply(`Starting session for **${name}**... Check console/logs for progress.`);

            executeSession(account.id).then(result => {
                if (result.success) {
                    interaction.followUp(`Session for **${name}** finished successfully.`).catch(err => logger.error('FollowUp error:', err));
                } else {
                    interaction.followUp(`Session for **${name}** failed: ${result.message}`).catch(err => logger.error('FollowUp error:', err));
                }
            }).catch(err => {
                logger.error(`Session execution error for ${name}:`, err);
                interaction.followUp(`❌ Critical error running session for **${name}**: ${err.message}`).catch(err => logger.error('FollowUp error:', err));
            });
        }
        else if (commandName === 'force_run_again_all') {
            await interaction.reply('🔄 **Resetting all accounts and restarting queue...**');
            await resetAllStatuses();

            // Start batch
            setImmediate(() => {
                runBatch().catch(err => logger.error('Batch run failed:', err));
            });
        }
        else if (commandName === 'force_run_error_all_again') {
            const count = await resetErrorStatuses();
            if (count === 0) {
                await interaction.reply({ content: '✅ No accounts found that are not "done".', ephemeral: true });
                return;
            }

            await interaction.reply(`🔄 **Resetting ${count} non-completed accounts and restarting queue...**`);

            // Start batch
            setImmediate(() => {
                runBatch().catch(err => logger.error('Batch run failed:', err));
            });
        }
        else if (commandName === 'force_run_all') {
            // Admin check
            const adminRoleId = await getAdminRole();
            const hasAdminRole = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
            const isDiscordAdmin = interaction.memberPermissions.has('Administrator');

            if (!hasAdminRole && !isDiscordAdmin) {
                await interaction.reply({ content: '❌ Admin permission required.', ephemeral: true });
                return;
            }

            const accounts = await getAccounts();
            await interaction.reply(`🚀 Starting ALL accounts (${accounts.length}) in queue...`);

            runBatch(accounts).then(() => {
                interaction.followUp(`✅ Queue complete - all accounts processed.`).catch(err => logger.error('FollowUp error:', err));
            }).catch(err => {
                interaction.followUp(`❌ Queue error: ${err.message}`).catch(err => logger.error('FollowUp error:', err));
            });
        }
        else if (commandName === 'force_stop_all') {
            // Admin check
            const adminRoleId = await getAdminRole();
            const hasAdminRole = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
            const isDiscordAdmin = interaction.memberPermissions.has('Administrator');

            if (!hasAdminRole && !isDiscordAdmin) {
                await interaction.reply({ content: '❌ Admin permission required.', ephemeral: true });
                return;
            }

            forceStop();
            await interaction.reply('🛑 **KILL-SWITCH ACTIVATED** - All processes will stop at next checkpoint.');
        }
        else if (commandName === 'set_log_channel') {
            // Admin check
            if (!interaction.memberPermissions.has('Administrator')) {
                await interaction.reply({ content: '❌ Admin permission required.', ephemeral: true });
                return;
            }

            const channel = interaction.options.getChannel('channel');
            if (!channel) throw new ValidationError('Invalid channel specified.');

            await setLogChannel(channel.id);
            await interaction.reply({ content: `✅ Log channel set to <#${channel.id}>. All bot notifications will be sent here.`, ephemeral: true });
        }
        else if (commandName === 'mute_bot' || commandName === 'unmute_bot') {
            // Admin check
            const adminRoleId = await getAdminRole();
            const hasAdminRole = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
            const isDiscordAdmin = interaction.memberPermissions.has('Administrator');

            if (!hasAdminRole && !isDiscordAdmin) {
                await interaction.reply({ content: '❌ Admin permission required.', ephemeral: true });
                return;
            }

            const action = commandName === 'mute_bot' ? 'muted' : 'unmuted';
            await interaction.reply({ content: `✅ Bot messages ${action}`, ephemeral: true });
        }
        else if (commandName === 'remove_account') {
            const name = requireTrimmedString(interaction.options.getString('name'), 'Account name', MAX_ACCOUNT_NAME_LENGTH);

            const removed = await removeAccount(name);

            if (removed) {
                await interaction.reply({ content: `Account **${name}** removed successfully.`, ephemeral: true });
            } else {
                await interaction.reply({ content: `Account **${name}** not found.`, ephemeral: true });
            }
        }
        else if (commandName === 'set_schedule') {
            const start = interaction.options.getInteger('start_hour');
            const end = interaction.options.getInteger('end_hour');

            if (start === null || end === null || start < 0 || start > 23 || end < 0 || end > 23) {
                await interaction.reply({ content: 'Hours must be between 0 and 23.', ephemeral: true });
                return;
            }

            // Format as HH:00
            const startStr = `${start.toString().padStart(2, '0')}:00`;
            const endStr = `${end.toString().padStart(2, '0')}:00`;

            await setSchedule(startStr, endStr);
            await interaction.reply({ content: `✅ Schedule updated! Active hours: **${startStr}** to **${endStr}**` });
        }
        else if (commandName === 'set_cookies') {
            const cookies = interaction.options.getString('cookies')?.trim();
            if (!cookies || cookies.length < 5) {
                throw new ValidationError('Invalid cookie string provided.');
            }
            if (cookies.length > MAX_COOKIE_LENGTH) {
                throw new ValidationError(`Cookie string must be ${MAX_COOKIE_LENGTH} characters or less.`);
            }
            await setCookies(cookies);
            await interaction.reply({ content: '✅ Global session cookies updated! New sessions will use these cookies.', ephemeral: true });
        }
        else if (commandName === 'set_admin_role') {
            // Check Discord Admin permissions
            if (!interaction.memberPermissions.has('Administrator')) {
                await interaction.reply({ content: '❌ Only Server Administrators can use this command.', ephemeral: true });
                return;
            }

            const role = interaction.options.getRole('role');
            if (!role) throw new ValidationError('Invalid role specified.');

            await setAdminRole(role.id);
            await interaction.reply({ content: `✅ Admin role set to **${role.name}**. Users with this role can now manage the bot.` });
        }
    } catch (error) {
        logger.error('Interaction Error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: `❌ Error: ${errorMessage}`, ephemeral: true }).catch(err => logger.error('FollowUp error:', err));
        } else {
            await interaction.reply({ content: `❌ Error: ${errorMessage}`, ephemeral: true }).catch(err => logger.error('FollowUp error:', err));
        }
    }
});

/**
 * Initializes and logs the Discord bot into the Discord API.
 * Uses the DISCORD_TOKEN environment variable.
 */
export const startBot = () => {
    logger.info('Initializing Discord bot connection...');
    client.login(process.env.DISCORD_TOKEN).catch(err => logger.error('Login failed:', err));
};

export { client };

/**
 * Sends a formatted logging message to the configured Discord channel.
 * Uses an embedded format color-coded based on the message type.
 * @param {string} message - The message content to send.
 * @param {'info'|'success'|'error'|'warning'} [type='info'] - The severity/type of the log.
 * @returns {Promise<void>}
 */
export const sendLog = async (message, type = 'info') => {
    // Try db first, fallback to env
    let channelId = await getLogChannel();
    logger.debug('sendLog called - channelId from db:', channelId);
    if (!channelId) {
        channelId = process.env.LOG_CHANNEL_ID;
        logger.debug('channelId from env:', channelId);
    }

    if (!channelId) {
        logger.debug('No channelId found - exiting sendLog');
        return; // No logging channel configured
    }

    logger.debug('Fetching Discord channel...');
    const channel = await client.channels.fetch(channelId).catch((err) => {
        logger.error('Channel fetch error:', err.message);
        return null;
    });
    
    if (!channel) {
        logger.error('Channel is null!');
        return;
    }
    logger.debug('Channel fetched OK, preparing message...');

    let color = 0x0099ff; // Blue (Info)
    if (type === 'success') color = 0x00ff00; // Green
    if (type === 'error') color = 0xff0000; // Red
    if (type === 'warning') color = 0xffff00; // Yellow

    const embed = new EmbedBuilder()
        .setDescription(message)
        .setColor(color)
        .setTimestamp();

    // Retry logic - try up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await channel.send({ embeds: [embed] });
            logger.debug('✅ Message sent to Discord!');
            return; // Success - exit
        } catch (err) {
            logger.warn(`Attempt ${attempt}/3 failed:`, err.message);
            if (attempt < 3) {
                // Wait before retry (exponential backoff)
                await new Promise(r => setTimeout(r, attempt * 1000));
            }
        }
    }
    logger.error('Failed to send log after 3 attempts');
};
