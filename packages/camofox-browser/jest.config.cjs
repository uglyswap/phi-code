module.exports = {
  // Disable transforms — we use native ESM via --experimental-vm-modules
  transform: {},
  testEnvironment: 'node',
  testTimeout: 60000, // 60 seconds per test
  
  // Run tests sequentially to avoid resource conflicts
  maxWorkers: 1,
  
  // Test file patterns
  testMatch: [
    '**/tests/**/*.test.js',
    '**/plugins/**/*.test.js',
    '**/scripts/**/*.test.js'
  ],
  
  // Ignore patterns
  //
  // The e2e suite has its own config (jest.config.e2e.cjs) because it needs a
  // globalSetup that boots ONE shared camofox server and writes its URLs to a temp
  // file. testMatch above sweeps in '**/tests/**', so without this exclusion every
  // e2e file ran here WITHOUT that setup and failed on the missing env file — 100
  // failures that looked like a broken browser and were a misrouted suite.
  //
  // The live suite talks to real third-party sites and is opt-in (npm run test:live).
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/tests/live/'
  ],
  
  // Setup and teardown
  globalSetup: undefined,
  globalTeardown: undefined,
  
  // Verbose output
  verbose: true,
  
  // Don't bail — run full suite even if a test fails
  bail: 0,
  
  // Coverage settings (optional)
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/'
  ],
  
  // Reporter settings
  reporters: [
    'default',
    ...(process.env.CI ? [['jest-junit', { outputDirectory: 'test-results' }]] : [])
  ]
};
