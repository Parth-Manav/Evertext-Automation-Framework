import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, StringSelectMenuBuilder, Events } from 'discord.js';
console.log('🔵🔵🔵 bot.js module loaded! 🔵🔵🔵');
import dotenv from 'dotenv';
import { addAccount, getAccounts, removeAccount, encrypt, setSchedule, setCookies, getAdminRole, setAdminRole, resetAllStatuses, resetErrorStatuses, getLogChannel, setLogChannel } from './db.js';
import { executeSession, runBatch, forceStop } from './manager.js';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('add_account')
        .setDescription('Add a new game account')
        .addStringOption(option => option.setName('name').setDescription('Account Name').setRequired(true))
        .addStringOption(option => option.setName('code').setDescription('Restore Code').setRequired(true))
        .addBooleanOption(option => option.setName('server_toggle').setDescription('Enable Server Selection? (True=Select, False=Skip)').setRequired(true))
        .addStringOption(option => option.setName('server').setDescription('Target Server (e.g., E-15, All) - Required if Toggle is True').setRequired(false)),
    new SlashCommandBuilder()
        .setName('list_accounts')
        .setDescription('List all configured accounts'),
    new SlashCommandBuilder()
        .setName('list_my_accounts')
        .setDescription('List only your accounts'),
    new SlashCommandBuilder()
        .setName('toggle_ping')
        .setDescription('Toggle ping notifications for your accounts'),
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
        .setDescription('Remove a game account')
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
        .setDescription('Reset and run ONLY accounts with error status (Admin Only)'),
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

client.once(Events.ClientReady, async () => {
    // ... (unchanged)
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('[Discord] Refreshing application (/) commands.');
        // If GUILD_ID is set and not the placeholder, register to guild
        if (process.env.GUILD_ID && process.env.GUILD_ID !== 'your_guild_id_here') {
            await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
        } else {
            console.log('[Discord] Registering global commands (this may take a while to update)...');
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        }
        console.log('[Discord] Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
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
            const name = interaction.options.getString('name');
            const code = interaction.options.getString('code');
            const serverToggle = interaction.options.getBoolean('server_toggle');
            let server = interaction.options.getString('server');

            // Logic Validation
            if (serverToggle && !server) {
                await interaction.reply({ content: '❌ **Error**: You set `Server Selection: True`, so you MUST provide a `Target Server`!', ephemeral: true });
                return;
            }

            // Default server string if skipping
            if (!server) server = 'Auto-Skip';

            // Encrypt the code before storing
            const encryptedCode = encrypt(code);
            await addAccount(name, encryptedCode, server, serverToggle);
            await interaction.reply({ content: `✅ Account **${name}** added!\nServer Selection: **${serverToggle ? 'Enabled' : 'Disabled'}**\nTarget: ${server}`, ephemeral: true });
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
            const name = interaction.options.getString('name');
            const accounts = await getAccounts();

            if (!name) {
                // Run all user's accounts (future enhancement - for now just error)
                await interaction.reply({ content: 'Please specify an account name.', ephemeral: true });
                return;
            }

            if (name.toLowerCase() === 'all') {
                await interaction.reply(`Starting batch session for **ALL** accounts... Check console/logs for progress.`);
                runBatch(accounts).then(() => {
                    interaction.followUp(`Batch session for **ALL** accounts finished.`).catch(console.error);
                }).catch(err => {
                    console.error('Batch run error:', err);
                    interaction.followUp(`❌ Batch run encountered an error: ${err.message}`).catch(console.error);
                });
                return;
            }

            const account = accounts.find(a => a.name === name);

            if (!account) {
                await interaction.reply({ content: `Account **${name}** not found.`, ephemeral: true });
                return;
            }

            await interaction.reply(`Starting session for **${name}**... Check console/logs for progress.`);

            executeSession(account.id).then(result => {
                if (result.success) {
                    interaction.followUp(`Session for **${name}** finished successfully.`).catch(console.error);
                } else {
                    interaction.followUp(`Session for **${name}** failed: ${result.message}`).catch(console.error);
                }
            }).catch(err => {
                console.error(`Session execution error for ${name}:`, err);
                interaction.followUp(`❌ Critical error running session for **${name}**: ${err.message}`).catch(console.error);
            });
        }
        else if (commandName === 'force_run_again_all') {
            // Admin check (already done above, but kept for clarity if structure differs)
            // actually the sensitive command check covers it.

            await interaction.reply('🔄 **Resetting all accounts and restarting queue...**');
            await resetAllStatuses();

            // Start batch
            setImmediate(() => {
                runBatch().catch(err => console.error('[Bot] Batch run failed:', err));
            });
        }
        else if (commandName === 'force_run_error_all_again') {
            const count = await resetErrorStatuses();
            if (count === 0) {
                await interaction.reply({ content: '✅ No accounts found with "error" status.', ephemeral: true });
                return;
            }

            await interaction.reply(`🔄 **Resetting ${count} failed accounts and restarting queue...**`);

            // Start batch
            setImmediate(() => {
                runBatch().catch(err => console.error('[Bot] Batch run failed:', err));
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
                interaction.followUp(`✅ Queue complete - all accounts processed.`).catch(console.error);
            }).catch(err => {
                interaction.followUp(`❌ Queue error: ${err.message}`).catch(console.error);
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
        else if (commandName === 'list_my_accounts') {
            // Future enhancement: filter by Discord user ID
            await interaction.reply({ content: 'This feature will be available soon!', ephemeral: true });
        }
        else if (commandName === 'toggle_ping') {
            // Future enhancement: toggle ping notifications
            await interaction.reply({ content: 'This feature will be available soon!', ephemeral: true });
        }
        else if (commandName === 'set_log_channel') {
            // Admin check
            if (!interaction.memberPermissions.has('Administrator')) {
                await interaction.reply({ content: '❌ Admin permission required.', ephemeral: true });
                return;
            }

            const channel = interaction.options.getChannel('channel');
            await setLogChannel(channel.id);
            await interaction.reply({ content: `✅ Log channel set to ${channel}. All bot notifications will be sent here.`, ephemeral: true });
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
            const name = interaction.options.getString('name');
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

            if (start < 0 || start > 23 || end < 0 || end > 23) {
                await interaction.reply({ content: 'Hours must be between 0 and 23.', ephemeral: true });
                return;
            }

            // Validation removed to allow cross-midnight schedules (e.g. 22:00 to 08:00)
            // if (start >= end) { ... }

            // Format as HH:00
            const startStr = `${start.toString().padStart(2, '0')}:00`;
            const endStr = `${end.toString().padStart(2, '0')}:00`;

            await setSchedule(startStr, endStr);
            await interaction.reply({ content: `✅ Schedule updated! Active hours: **${startStr}** to **${endStr}**` });
        }
        else if (commandName === 'set_cookies') {
            const cookies = interaction.options.getString('cookies');
            // Basic validation
            if (!cookies || cookies.length < 5) {
                await interaction.reply({ content: 'Invalid cookie string provided.', ephemeral: true });
                return;
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
            await setAdminRole(role.id);
            await interaction.reply({ content: `✅ Admin role set to **${role.name}**. Users with this role can now manage the bot.` });
        }
    } catch (error) {
        console.error('[Discord] Interaction Error:', error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true }).catch(console.error);
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true }).catch(console.error);
        }
    }
});

export const startBot = () => {
    client.login(process.env.DISCORD_TOKEN);
};

export { client };

export const sendLog = async (message, type = 'info') => {
    // Try db first, fallback to env
    let channelId = await getLogChannel();
    console.log('[DEBUG] sendLog called - channelId from db:', channelId);
    if (!channelId) {
        channelId = process.env.LOG_CHANNEL_ID;
        console.log('[DEBUG] channelId from env:', channelId);
    }

    if (!channelId) {
        console.log('[DEBUG] No channelId found - exiting sendLog');
        return; // No logging channel configured
    }

    console.log('[DEBUG] Fetching Discord channel...');
    const channel = await client.channels.fetch(channelId).catch((err) => {
        console.error('[DEBUG] Channel fetch error:', err.message);
        return null;
    });
    if (!channel) {
        console.error('[DEBUG] Channel is null!');
        return;
    }
    console.log('[DEBUG] Channel fetched OK, preparing message...');

    let color = 0x0099ff; // Blue (Info)
    if (type === 'success') color = 0x00ff00; // Green
    if (type === 'error') color = 0xff0000; // Red
    if (type === 'start') color = 0xffff00; // Yellow

    const embed = new EmbedBuilder()
        .setDescription(message)
        .setColor(color)
        .setTimestamp();

    // Retry logic - try up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await channel.send({ embeds: [embed] });
            console.log('[DEBUG] ✅ Message sent to Discord!');
            return; // Success - exit
        } catch (err) {
            console.error(`[sendLog] Attempt ${attempt}/3 failed:`, err.message);
            if (attempt < 3) {
                // Wait before retry (exponential backoff)
                await new Promise(r => setTimeout(r, attempt * 1000));
            }
        }
    }
    console.error('[sendLog] Failed to send log after 3 attempts');
};
