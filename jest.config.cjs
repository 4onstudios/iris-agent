module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(mjs|cjs|js|jsx|ts|tsx)$": "babel-jest",
  },
  transformIgnorePatterns: [],
  testPathIgnorePatterns: [
    "<rootDir>/tests/dist/",
    "<rootDir>/(api|src)/.*?/dist/",
  ],
};
