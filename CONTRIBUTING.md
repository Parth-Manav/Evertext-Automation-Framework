# Contributing Guidelines

Thank you for contributing to the Evertext Automation Framework.

## Development Environment Setup

### Prerequisites

- Node.js v18+ (ES modules)
- Rust / Cargo

### Local installation

```bash
npm install

cd evertext_brain
cargo build --release
cd ..
```

Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.

```bash
npm start
```

## Running the Rust Brain Standalone

Build the release binary:

```bash
cd evertext_brain
cargo build --release
```

Send JSON lines to stdin (PowerShell example):

```powershell
'{"type":"init"}' | .\target\release\evertext_brain.exe
```

On Linux/macOS:

```bash
echo '{"type":"init"}' | ./target/release/evertext_brain
```

Then send terminal output:

```json
{"type":"terminal_output","content":"Enter Command to use","account":{"code":"test","targetServer":"E-15","server_toggle":false}}
```

Read one JSON line per response from stdout.

## Code Style Conventions

### Node.js

- ES modules (`import` / `export`); `type: "module"` in `package.json`
- **Do not** use `console.log` in `src/` — use `createLogger('module')` from `src/logger.js`
- Use typed errors from `src/errors.js` at boundaries
- Magic numbers belong in `src/constants.js` (re-exported via `src/config.js` for legacy imports)
- JSDoc on all exported functions and classes

### Rust

- `///` doc comments on public items
- Terminal match strings as `MSG_*` constants at file top
- Avoid unnecessary `.clone()` on large strings

## Adding a New Discord Command Handler

1. Add a `SlashCommandBuilder` entry in `src/bot.js` `commands` array
2. Handle the command in the `interactionCreate` listener
3. Add to `sensitiveCommands` if admin-only
4. Use `ValidationError` for invalid user input
5. Delegate long work to `manager.js` — reply immediately, `followUp` when done

Example pattern:

```js
else if (commandName === 'my_command') {
    const value = interaction.options.getString('value');
    if (!value?.trim()) throw new ValidationError('value is required');
    await interaction.reply({ content: 'Started...', ephemeral: true });
    // async work...
}
```

## Pull Request Process

1. Branch from `main`: `git checkout -b feature/your-feature`
2. Ensure `cargo build --release` succeeds with no warnings you introduced
3. Verify `npm start` launches without syntax errors
4. Describe behavioral impact — especially any IPC message changes (discouraged)

## Testing Checklist

- [ ] Rust brain compiles: `cargo build --release`
- [ ] No `console.*` outside `src/logger.js` in `src/`
- [ ] New constants added to `src/constants.js`, not inline
- [ ] JSDoc on new exports
