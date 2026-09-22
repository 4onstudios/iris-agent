module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(mjs|cjs|js|jsx|ts|tsx)$": "babel-jest",
  },
  transformIgnorePatterns: [],
  testPathIgnorePatterns: [
    "<rootDir>/dist/",
    "<rootDir>/tests/dist/",
    "<rootDir>/(api|src)/.*?/dist/",
  ],
  // @tanstack/ai(-compaction|-utils|-event-client) ship ESM-only root
  // exports (no "require" condition). Map them directly to their
  // compiled ESM entry points so Jest's CJS resolver can find them;
  // babel-jest (with transformIgnorePatterns disabled above) then
  // transpiles the ESM syntax to CommonJS like any other test dependency.
  moduleNameMapper: {
    "^@tanstack/ai-compaction$":
      "<rootDir>/node_modules/@tanstack/ai-compaction/dist/esm/index.js",
    "^@tanstack/ai-utils$":
      "<rootDir>/node_modules/@tanstack/ai-utils/dist/esm/index.js",
    "^@tanstack/ai-event-client$":
      "<rootDir>/node_modules/@tanstack/ai-event-client/dist/esm/index.js",
    "^@tanstack/ai$": "<rootDir>/node_modules/@tanstack/ai/dist/esm/index.js",
  },
};
