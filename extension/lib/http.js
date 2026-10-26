// Запросы к API с повтором при лимитах (429) и временных ошибках сервера.

export class ApiError extends Error {
  constructor(message, { status, fatal = false } = {}) {
    super(message);
    this.status = status;
    // fatal — продолжать бессмысленно (например, истёк вход в сервис).
    this.fatal = fatal;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function request(url, init = {}, { service = "", retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt >= retries) throw new ApiError(`${service}: нет связи с сервером`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    if (response.status === 401) {
      throw new ApiError(`${service}: вход устарел, подключите сервис заново`, { status: 401, fatal: true });
    }
    if (response.status === 418) {
      // Так отвечает защита от ботов (например, у Звука) — повторять бесполезно.
      throw new ApiError(`${service}: запрос заблокирован защитой от ботов, попробуйте позже`, {
        status: 418, fatal: true,
      });
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries) {
      const body = (await response.text().catch(() => "")).trim();
      const where = `${init.method || "GET"} ${new URL(url).pathname}`;
      const details = body ? `: ${body.slice(0, 200)}` : "";
      throw new ApiError(`${service}: ошибка ${response.status} (${where})${details}`, {
        status: response.status,
        fatal: response.status === 403,
      });
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
  }
}

export function form(data) {
  return new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]));
}
