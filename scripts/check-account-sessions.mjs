import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Writable } from 'node:stream';

const api = 'https://api.yani.tv';
const applicationToken = process.env.VITE_YUMMY_APPLICATION_TOKEN?.trim();

async function request(path, { token, body, method = 'GET', allowUnauthorized = false } = {}) {
  let reply;

  try {
    reply = await fetch(`${api}${path}`, {
      method,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        Lang: 'ru',
        ...(applicationToken ? { 'X-Application': applicationToken } : {}),
        ...(token ? { Authorization: `Yummy ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`${method} ${path}: не удалось получить ответ от ${api}.`);
  }

  const payload = await reply.json().catch(() => null);

  if (reply.status === 420 || payload?.error_code === 5)
    throw new Error(`${method} ${path}: YummyAnime запросил капчу.`);
  if (reply.status === 401 && allowUnauthorized) return null;
  if (!reply.ok || payload?.error)
    throw new Error(`${method} ${path}: ошибка API (HTTP ${reply.status}).`);
  if (!payload || !Object.hasOwn(payload, 'response') || payload.response === null)
    throw new Error(`${method} ${path}: неожиданный формат ответа.`);

  return payload.response;
}

async function readCredentials() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Запусти проверку в интерактивном терминале.');

  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (hidden) done();
      else process.stdout.write(chunk, encoding, done);
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });

  input.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(130);
  });

  try {
    console.log('Используй тестовый аккаунт. Проверка выполняет выход из сессий на сервере.');
    const login = (await input.question('Почта тестового аккаунта: ')).trim();

    hidden = true;
    process.stdout.write('Пароль (ввод скрыт): ');
    const password = await input.question('');

    if (!login || !password) throw new Error('Для проверки нужны почта и пароль.');

    return { login, password, need_json: true };
  } finally {
    input.close();
    if (hidden) process.stdout.write('\n');
  }
}

async function login(body) {
  const response = await request('/profile/login', { method: 'POST', body });

  if (response?.success !== true || typeof response.token !== 'string' || !response.token)
    throw new Error('YummyAnime не вернул токен при входе.');

  return response.token;
}

async function profile(token) {
  const response = await request('/profile', { token, allowUnauthorized: true });

  if (response === null) return null;
  if (!Number.isInteger(response?.id) || response.id <= 0)
    throw new Error('YummyAnime вернул профиль без идентификатора.');

  return response.id;
}

async function check(label, token, accountId) {
  const id = await profile(token);

  if (id !== null && id !== accountId) throw new Error('API вернул профиль другого аккаунта.');
  console.log(`${label} — ${id === null ? 'отклонён (HTTP 401)' : 'действует'}`);

  return id !== null;
}

async function loginPair(body) {
  const first = await login(body);
  const accountId = await profile(first);

  if (accountId === null) throw new Error('Токен первого входа сразу отклонён.');

  // Separate logins by more than a second in case token timestamps use whole seconds.
  await sleep(1_100);
  const second = await login(body);

  console.log(`Токены A и B после двух входов — ${first === second ? 'совпадают' : 'разные'}`);
  const firstActive = await check('A после входа B', first, accountId);

  if (!(await check('B после входа B', second, accountId)))
    throw new Error('Токен второго входа сразу отклонён.');

  return { first, second, accountId, firstActive };
}

async function logout(token) {
  if ((await request('/profile/logout', { method: 'POST', token })) !== true)
    throw new Error('YummyAnime не подтвердил выход.');
}

async function run() {
  const credentials = await readCredentials();
  const { first, second, accountId, firstActive } = await loginPair(credentials);
  const active = firstActive ? first : second;
  const source = firstActive ? 'A' : 'B';
  const independent = firstActive && first !== second;
  const { token: refreshed } = await request('/profile/token', { token: active });

  if (typeof refreshed !== 'string' || !refreshed)
    throw new Error('YummyAnime не вернул токен при обновлении.');

  console.log(`Обновление ${source} — ${active === refreshed ? 'тот же токен' : 'новый токен'}`);
  if (!(await check('Обновлённый токен', refreshed, accountId)))
    throw new Error('Обновлённый токен сразу отклонён.');
  await check('Исходный токен после обновления', active, accountId);
  const secondActive = independent && (await check('B после обновления A', second, accountId));

  await logout(refreshed);
  await check('Обновлённый токен после выхода с ним', refreshed, accountId);
  await check('Исходный токен после выхода с обновлённым', active, accountId);

  if (secondActive) {
    await check('B после выхода A', second, accountId);
  } else if (independent) {
    console.log('\nПроверка выхода на свежей паре сессий без обновления токена');
    const pair = await loginPair(credentials);

    if (pair.accountId !== accountId || !pair.firstActive || pair.first === pair.second)
      throw new Error('Не удалось получить два разных действующих токена для проверки выхода.');

    await logout(pair.first);
    await check('A после выхода A', pair.first, accountId);
    await check('B после выхода A', pair.second, accountId);
  }
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
