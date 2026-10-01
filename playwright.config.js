import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.js',
  outputDir: './artifacts/browser-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1080 },
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
