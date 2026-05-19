# Contributing Guidelines

Thank you for contributing to the Evertext Automation Framework! This document outlines the standards and procedures for submitting code.

## Development Environment Setup

1. **Node.js**: Ensure you are running Node v18 or newer. We heavily utilize ES Modules, async/await, and modern language features.
2. **Rust**: You must have `cargo` installed. We compile the decision engine to a native binary for performance.

### Local Installation
```bash
# Install Node dependencies
npm install

# Compile the Rust brain
cd evertext_brain
cargo build --release
```

## Coding Standards

### Node.js Layer
- **ES Modules:** We strictly use ES Modules (`import`/`export`). Ensure `type: "module"` remains in `package.json`.
- **Logging:** **DO NOT** use `console.log`. Always import `createLogger` from `src/logger.js` and use `logger.info()`, `logger.debug()`, `logger.warn()`, or `logger.error()`.
- **Error Handling:** Use custom error classes defined in `src/errors.js` (e.g., `SessionExpiredError`, `ServerFullError`) rather than generic generic `Error` objects where applicable. Always validate inputs at public boundaries.
- **JSDoc:** All public functions, classes, and complex logic blocks must include complete JSDoc annotations to aid IDE intellisense and future maintainability.

### Rust Layer
- **Documentation:** Use `///` doc comments for all public structs, enums, and functions.
- **Constants:** Never use raw string literals for terminal matching directly in the `match` branches. Extract all target strings to named constants at the top of the file.
- **Performance:** Avoid unnecessary `.clone()` calls. When slicing strings, ensure you are not splitting multi-byte UTF-8 characters.

## Pull Request Process

1. Create a feature branch (`git checkout -b feature/your-feature-name`).
2. Implement your changes following the coding standards.
3. Verify that the Rust brain compiles without warnings (`cargo build --release`).
4. Submit a Pull Request with a detailed description of the architectural changes and any new IPC messages introduced.
