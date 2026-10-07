const base = require("./playwright.config");

// Driven by tests/run-first-run.sh, against a stack with no admin configured.
module.exports = { ...base, testDir: "./first-run", testIgnore: [] };
