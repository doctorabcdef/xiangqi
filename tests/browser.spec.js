import { test, expect } from '@playwright/test';

const CLOUD_API = 'https://yijian-xiangqi-sync.cx668899668899.chatgpt.site/api/game';
const STORAGE_KEY = 'yijian.xiangqi.v1';

function cloudServer() {
  const games = new Map();
  async function attach(context) {
    const connection = { offline: false };
    await context.route(CLOUD_API, async route => {
      if (connection.offline) return route.abort('internetdisconnected');
      const request = route.request();
      const code = request.headers().authorization?.replace(/^Bearer /, '');
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
      const reply = (status, json) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(json) });
      if (request.method() === 'OPTIONS') return reply(200, {});
      if (!code) return reply(401, { error: 'Missing sync code' });
      const existing = games.get(code);
      if (request.method() === 'GET') return existing ? reply(200, existing) : reply(404, { error: 'Not found' });
      const body = request.postDataJSON();
      if (body.baseRevision !== (existing?.revision ?? 0)) return reply(409, existing);
      const saved = structuredClone({ revision: (existing?.revision ?? 0) + 1, state: body.state });
      games.set(code, saved);
      return reply(200, saved);
    });
    return connection;
  }
  return { games, attach };
}

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#game-status')).not.toHaveText('恢复棋局中');
  await expect(page.locator('#save-label')).toHaveText('已同步到云端');
}

async function move(page, from, to) {
  await page.locator(`[data-index="${from}"]`).click();
  await expect(page.locator(`[data-index="${to}"]`)).toHaveClass(/target/);
  await page.locator(`[data-index="${to}"]`).click();
}

async function snapshot(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

async function saved(page) {
  await expect(page.locator('#save-label')).toHaveText('已同步到云端');
}

async function poll(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await saved(page);
}

async function openSecondDevice(browser, cloud, first) {
  const code = (await snapshot(first)).code;
  const cloudBeforeOpen = structuredClone(cloud.games.get(code));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const connection = await cloud.attach(context);
  const page = await context.newPage();
  await ready(page);
  await expect(page.locator('#sync-dialog')).not.toBeVisible();
  await expect(page.locator('#conflict-dialog')).not.toBeVisible();
  expect((await snapshot(page)).code).toBe(code);
  expect((await snapshot(page)).state.moves).toEqual(cloudBeforeOpen.state.moves);
  // A fresh browser must load the shared table without writing an empty board.
  expect(cloud.games.get(code)).toEqual(cloudBeforeOpen);
  return { context, page, connection, code };
}

test('local game saves, reloads, flips and undoes a move', async ({ page, context }) => {
  const cloud = cloudServer();
  await cloud.attach(context);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await expect(page.locator('.piece')).toHaveCount(32);
  await page.locator('#mode-local').click();
  await move(page, 54, 45);
  await move(page, 27, 36);
  await saved(page);
  const before = await snapshot(page);
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await page.reload();
  await expect(page.locator('#move-count')).toHaveText('2 手');
  await saved(page);
  expect((await snapshot(page)).state.moves).toEqual(before.state.moves);
  await page.locator('#flip').click();
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);
  await page.reload();
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await expect(page.locator('[data-index="27"] .piece')).toHaveText('卒');
  expect(errors).toEqual([]);
});

test('captured-piece trays retain ownership when flipped and undo syncs restored pieces across browsers', async ({ page, context, browser }) => {
  const cloud = cloudServer();
  await cloud.attach(context);
  await ready(page);
  await page.locator('#mode-local').click();
  const blackCaptures = page.locator('#black-captured');
  const redCaptures = page.locator('#red-captured');
  await expect(blackCaptures.locator('.piece')).toHaveCount(0);
  await expect(redCaptures.locator('.piece')).toHaveCount(0);
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#undo-board')).toBeDisabled();

  // Each cannon jumps the opposing cannon to take a horse on the far rank.
  await move(page, 64, 1);
  await expect(redCaptures.locator('.piece.black')).toHaveText('马');
  await expect(blackCaptures.locator('.piece')).toHaveCount(0);
  await move(page, 25, 88);
  await expect(blackCaptures.locator('.piece.red')).toHaveText('马');
  await expect(redCaptures.locator('.piece.black')).toHaveText('马');
  await expect(page.locator('#black-capture-count')).toHaveText('1 枚');
  await expect(page.locator('#red-capture-count')).toHaveText('1 枚');
  await expect(blackCaptures.locator('.piece.red')).toHaveAttribute('aria-label', '黑方吃掉的红方马');
  await expect(redCaptures.locator('.piece.black')).toHaveAttribute('aria-label', '红方吃掉的黑方马');
  await expect(page.locator('#board .piece')).toHaveCount(30);
  await expect(page.locator('#undo')).toBeEnabled();
  await expect(blackCaptures.locator('.piece.red')).toHaveCSS('border-radius', '50%');
  await expect(redCaptures.locator('.piece.black')).toHaveCSS('border-radius', '50%');
  const boardColors = await page.locator('#board .piece').evaluateAll(pieces => ({
    red: getComputedStyle(pieces.find(piece => piece.classList.contains('red'))).color,
    black: getComputedStyle(pieces.find(piece => piece.classList.contains('black'))).color,
  }));
  await expect(blackCaptures.locator('.piece.red')).toHaveCSS('color', boardColors.red);
  await expect(redCaptures.locator('.piece.black')).toHaveCSS('color', boardColors.black);
  const boardBounds = await page.locator('.board-frame').boundingBox();
  for (const tray of [blackCaptures, redCaptures]) {
    const bounds = await tray.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(boardBounds.x);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(blackCaptures.locator('.piece.red')).toBeVisible();
  await expect(redCaptures.locator('.piece.black')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1080 });

  await saved(page);
  await page.reload();
  await expect(page.locator('#move-count')).toHaveText('2 手');
  await expect(blackCaptures.locator('.piece.red')).toHaveText('马');
  await expect(redCaptures.locator('.piece.black')).toHaveText('马');
  await page.locator('#flip').click();
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);
  await expect(blackCaptures.locator('.piece.red')).toHaveText('马');
  await expect(redCaptures.locator('.piece.black')).toHaveText('马');

  const second = await openSecondDevice(browser, cloud, page);
  try {
    await expect(second.page.locator('#black-captured .piece.red')).toHaveText('马');
    await expect(second.page.locator('#red-captured .piece.black')).toHaveText('马');
    await second.page.locator('#undo').click();
    await expect(second.page.locator('#move-count')).toHaveText('1 手');
    await expect(second.page.locator('#black-captured .piece')).toHaveCount(0);
    await expect(second.page.locator('#black-capture-count')).toHaveText('0 枚');
    await expect(second.page.locator('#red-capture-count')).toHaveText('1 枚');
    await expect(second.page.locator('#red-captured .piece.black')).toHaveText('马');
    await expect(second.page.locator('[data-index="88"] .piece.red')).toHaveText('马');
    await expect(second.page.locator('[data-index="25"] .piece.black')).toHaveText('炮');
    await saved(second.page);
    await poll(page);
    await expect(page.locator('#move-count')).toHaveText('1 手');
    await expect(blackCaptures.locator('.piece')).toHaveCount(0);
    await expect(page.locator('[data-index="88"] .piece.red')).toHaveText('马');
    await page.reload();
    await expect(page.locator('#move-count')).toHaveText('1 手');
    await expect(blackCaptures.locator('.piece')).toHaveCount(0);
    await expect(redCaptures.locator('.piece.black')).toHaveText('马');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#undo-board')).toBeEnabled();
    await page.locator('#undo-board').click();
    await expect(page.locator('#move-count')).toHaveText('0 手');
    await expect(blackCaptures.locator('.piece')).toHaveCount(0);
    await expect(redCaptures.locator('.piece')).toHaveCount(0);
    await expect(page.locator('[data-index="1"] .piece.black')).toHaveText('马');
    await expect(page.locator('[data-index="64"] .piece.red')).toHaveText('炮');
    await expect(page.locator('#board .piece')).toHaveCount(32);
    await saved(page);
    await poll(second.page);
    await expect(second.page.locator('#move-count')).toHaveText('0 手');
    await expect(second.page.locator('#black-captured .piece, #red-captured .piece')).toHaveCount(0);
    expect((await snapshot(second.page)).state.moves).toEqual([]);
  } finally { await second.context.close(); }
});

test('refresh while AI is thinking recovers its move and undo restores both turns', async ({ page, context }) => {
  await cloudServer().attach(context);
  await ready(page);
  await page.locator('#difficulty').selectOption('easy');
  await move(page, 54, 45);
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await page.reload();
  await expect(page.locator('#move-count')).toHaveText('2 手');
  await expect(page.locator('#game-status')).toHaveText('红方行棋');
  expect((await snapshot(page)).state.moves[0]).toEqual({ from: 54, to: 45 });
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('0 手');
  await expect(page.locator('#game-status')).toHaveText('红方先行');
});

test('human black gets a red AI opening and keeps its side through undo, reload, another browser and new game', async ({ page, context, browser }) => {
  const cloud = cloudServer();
  await cloud.attach(context);
  await ready(page);
  await expect(page.locator('#human-side')).toHaveValue('red');
  await page.locator('#difficulty').selectOption('easy');
  await page.locator('#human-side').selectOption('black');
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);
  await expect(page.locator('#bottom-name')).toHaveText('我方棋手');
  await expect(page.locator('#top-name')).toHaveText('电脑棋手');
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#undo-board')).toBeDisabled();
  const opening = (await snapshot(page)).state.moves;
  expect(opening).toHaveLength(1);
  expect((await snapshot(page)).state.humanSide).toBe('black');
  await page.screenshot({ path: 'artifacts/human-black-desktop.png', fullPage: true });

  await page.locator('#board .square:has(.piece.red)').first().click();
  await expect(page.locator('#board .square.selected')).toHaveCount(0);
  await expect(page.locator('#board .square.target')).toHaveCount(0);
  expect((await snapshot(page)).state.moves).toEqual(opening);
  await move(page, 27, 36);
  await expect(page.locator('#move-count')).toHaveText('3 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('1 手');
  expect((await snapshot(page)).state.moves).toEqual(opening);
  await expect(page.locator('[data-index="27"] .piece.black')).toHaveText('卒');
  await saved(page);

  await page.reload();
  await expect(page.locator('#human-side')).toHaveValue('black');
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  await expect(page.locator('#undo')).toBeDisabled();
  const second = await openSecondDevice(browser, cloud, page);
  try {
    await expect(second.page.locator('#human-side')).toHaveValue('black');
    await expect(second.page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);
    await expect(second.page.locator('#game-status')).toHaveText('黑方行棋');
    await expect(second.page.locator('#undo')).toBeDisabled();
    expect((await snapshot(second.page)).state.humanSide).toBe('black');
  } finally { await second.context.close(); }

  await page.locator('#new-game').click();
  await page.locator('#confirm-action').click();
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  await expect(page.locator('#human-side')).toHaveValue('black');
  expect((await snapshot(page)).state.humanSide).toBe('black');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#human-side')).toBeVisible();
  await page.screenshot({ path: 'artifacts/human-black-mobile.png', fullPage: true });
});

test('human black can undo a pending red AI reply and refresh resumes exactly one red reply', async ({ page, context }) => {
  await cloudServer().attach(context);
  await page.addInitScript(() => {
    window.__holdAI = false;
    window.__heldAI = false;
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      postMessage(value, ...rest) {
        if (window.__holdAI) { window.__heldAI = true; return; }
        return super.postMessage(value, ...rest);
      }
    };
  });
  await ready(page);
  await page.locator('#difficulty').selectOption('easy');
  await page.locator('#human-side').selectOption('black');
  await expect(page.locator('#move-count')).toHaveText('1 手');
  const opening = (await snapshot(page)).state.moves;
  await page.evaluate(() => { window.__holdAI = true; });
  await move(page, 27, 36);
  await expect.poll(() => page.evaluate(() => window.__heldAI)).toBe(true);
  await expect(page.locator('#move-count')).toHaveText('2 手');
  await expect(page.locator('#game-status')).toHaveText('红方思考中');
  await expect(page.locator('#undo-board')).toBeEnabled();
  await page.locator('#undo-board').click();
  await expect(page.locator('#move-count')).toHaveText('1 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  expect((await snapshot(page)).state.moves).toEqual(opening);
  await expect(page.locator('#undo-board')).toBeDisabled();

  // Keep the reply pending until reload; the new page's real worker must finish it.
  await move(page, 27, 36);
  await expect(page.locator('#move-count')).toHaveText('2 手');
  await page.reload();
  await expect(page.locator('#move-count')).toHaveText('3 手');
  await expect(page.locator('#game-status')).toHaveText('黑方行棋');
  expect((await snapshot(page)).state.moves.slice(0, 2)).toEqual([...opening, { from: 27, to: 36 }]);
  await page.locator('#undo').click();
  await expect(page.locator('#move-count')).toHaveText('1 手');
  expect((await snapshot(page)).state.moves).toEqual(opening);
});

test('canceling a side change preserves black progress and confirming it starts a fresh red game', async ({ page, context }) => {
  await cloudServer().attach(context);
  await ready(page);
  await page.locator('#difficulty').selectOption('easy');
  await page.locator('#human-side').selectOption('black');
  await expect(page.locator('#move-count')).toHaveText('1 手');
  const before = (await snapshot(page)).state;
  await page.locator('#human-side').selectOption('red');
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-dialog').getByRole('button', { name: '再想想', exact: true }).click();
  await expect(page.locator('#confirm-dialog')).not.toBeVisible();
  await expect(page.locator('#human-side')).toHaveValue('black');
  expect((await snapshot(page)).state).toEqual(before);
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /黑方在下方/);

  await page.locator('#human-side').selectOption('red');
  await page.locator('#confirm-action').click();
  await expect(page.locator('#human-side')).toHaveValue('red');
  await expect(page.locator('#move-count')).toHaveText('0 手');
  await expect(page.locator('#game-status')).toHaveText('红方先行');
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /红方在下方/);
  expect((await snapshot(page)).state.humanSide).toBe('red');
  await page.locator('#mode-local').click();
  await expect(page.locator('#human-side')).toBeHidden();
});

test('fresh browsers automatically resume the shared board without codes or startup overwrites', async ({ page, context, browser }) => {
  const cloud = cloudServer();
  await cloud.attach(context);
  await ready(page);
  await page.locator('#mode-local').click();
  await move(page, 54, 45);
  await saved(page);
  const second = await openSecondDevice(browser, cloud, page);
  try {
    await expect(second.page.locator('#move-count')).toHaveText('1 手');
    expect((await snapshot(second.page)).code).toBe(second.code);
    await move(second.page, 27, 36);
    await saved(second.page);
    await poll(page);
    await expect(page.locator('#move-count')).toHaveText('2 手');
    expect((await snapshot(page)).state.moves).toEqual((await snapshot(second.page)).state.moves);
    await second.page.reload();
    await expect(second.page.locator('#move-count')).toHaveText('2 手');
    const third = await openSecondDevice(browser, cloud, page);
    try {
      await expect(third.page.locator('#move-count')).toHaveText('2 手');
      await expect(third.page.locator('#mode-local')).toHaveAttribute('aria-pressed', 'true');
    } finally { await third.context.close(); }
  } finally { await second.context.close(); }
});

test('invalid import and unknown sync code preserve the current game', async ({ page, context }) => {
  await cloudServer().attach(context);
  await ready(page);
  await page.locator('#mode-local').click();
  await move(page, 54, 45);
  const before = (await snapshot(page)).state.moves;
  await page.locator('#import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{not valid json') });
  await expect(page.locator('#toast')).toHaveText('文件不是有效的棋局 JSON');
  await expect(page.locator('#confirm-dialog')).not.toBeVisible();
  const badState = { version: 1, mode: 'local', difficulty: 'easy', moves: [{ from: 54, to: 0 }] };
  await page.locator('#import-file').setInputFiles({ name: 'illegal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(badState)) });
  await expect(page.locator('#toast')).toContainText(/非法|着法|合法|棋谱/);
  expect((await snapshot(page)).state.moves).toEqual(before);
  await page.locator('#sync-open').click();
  await page.locator('#join-code').fill('a'.repeat(32));
  await page.locator('#join-game').click();
  await page.locator('#confirm-action').click();
  await expect(page.locator('#join-error')).toContainText('找不到这个棋局');
  expect((await snapshot(page)).state.moves).toEqual(before);
});

for (const choice of ['cloud', 'local']) {
  test(`offline divergent moves show conflict and preserve selected ${choice} progress`, async ({ page, context, browser }) => {
    const cloud = cloudServer();
    await cloud.attach(context);
    await ready(page);
    await page.locator('#mode-local').click();
    await move(page, 54, 45);
    await saved(page);
    const second = await openSecondDevice(browser, cloud, page);
    try {
      second.connection.offline = true;
      await move(second.page, 29, 38);
      await expect(second.page.locator('#save-label')).toHaveText('已存本机，等待联网同步');
      await move(page, 27, 36);
      await saved(page);
      second.connection.offline = false;
      await second.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(second.page.locator('#conflict-dialog')).toBeVisible();
      await expect(second.page.locator('#undo')).toBeDisabled();
      await second.page.keyboard.press('Escape');
      await expect(second.page.locator('#conflict-dialog')).toBeVisible();
      await second.page.locator(`#use-${choice}`).click();
      await expect(second.page.locator('#conflict-dialog')).not.toBeVisible();
      await saved(second.page);
      const expected = choice === 'cloud' ? { from: 27, to: 36 } : { from: 29, to: 38 };
      expect((await snapshot(second.page)).state.moves.at(-1)).toEqual(expected);
      expect(cloud.games.get(second.code).state.moves.at(-1)).toEqual(expected);
      await poll(page);
      expect((await snapshot(page)).state.moves.at(-1)).toEqual(expected);
    } finally { await second.context.close(); }
  });
}

test('mobile board, dialogs and controls fit without horizontal overflow', async ({ page, context }) => {
  await cloudServer().attach(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator('#mode-local').click();
  await move(page, 54, 45);
  await saved(page);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(await noOverflow()).toBe(true);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  await page.locator('#sync-open').click();
  await expect(page.locator('#sync-dialog')).toBeVisible();
  expect(await noOverflow()).toBe(true);
  const bounds = await page.locator('#sync-dialog').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/mobile-sync.png', fullPage: true });
  await page.locator('[data-close="sync-dialog"]').click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await noOverflow()).toBe(true);
});
