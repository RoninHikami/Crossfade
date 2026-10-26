// Вход в сервисы. Токены хранятся только локально, в chrome.storage.local.

import { SPOTIFY_CLIENT_ID, YANDEX_CLIENT_ID } from "../config.js";
import { YandexService } from "./services/yandex.js";

const SPOTIFY_SCOPES = "user-library-read user-library-modify";

export async function getAuth() {
  return (await chrome.storage.local.get("auth")).auth || {};
}

async function setAuth(service, value) {
  const auth = await getAuth();
  if (value) auth[service] = value;
  else delete auth[service];
  await chrome.storage.local.set({ auth });
}

export async function disconnect(service) {
  await setAuth(service, null);
}

// --- Яндекс Музыка ----------------------------------------------------------
// Открываем страницу входа Яндекса во вкладке и забираем токен из адреса,
// на который Яндекс перенаправит после входа.

// Вход может занять несколько минут, а фоновый скрипт расширения за это время
// успевает «уснуть». Поэтому сам токен ловит постоянный обработчик
// handleYandexTabUpdate (он подключён в background.js), а здесь мы только
// открываем вкладку и запоминаем, что ждём входа.

export async function connectYandex() {
  await chrome.storage.session.set({ yandexLoginPending: true });
  await chrome.tabs.create({
    url: `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_CLIENT_ID}`,
  });
}

// Адреса вкладок видны расширению только на доменах Яндекса из manifest.json.
export async function handleYandexTabUpdate(tabId, url) {
  const match = (url || "").match(/[#&?]access_token=([^&]+)/);
  if (!match) return;
  const { yandexLoginPending } = await chrome.storage.session.get("yandexLoginPending");
  if (!yandexLoginPending) return;
  await chrome.storage.session.remove("yandexLoginPending");
  chrome.tabs.remove(tabId).catch(() => {});
  try {
    await saveYandexToken(decodeURIComponent(match[1]));
  } catch (error) {
    await chrome.storage.session.set({ authError: `Яндекс Музыка: ${error.message}` });
  }
}

export async function saveYandexToken(token) {
  const account = await YandexService.account(token.trim());
  await setAuth("yandex", { token: token.trim(), uid: account.uid, name: account.name });
  return account.name;
}

// --- Spotify (Authorization Code + PKCE, без секрета) -----------------------

export function spotifyRedirectUri() {
  return chrome.identity.getRedirectURL();
}

export async function spotifyClientId() {
  const { settings } = await chrome.storage.local.get("settings");
  return SPOTIFY_CLIENT_ID || settings?.spotifyClientId || "";
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenRequest(params) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Spotify: ${data.error_description || data.error || response.status}`);
  return data;
}

function tokenRecord(data, previous = {}) {
  return {
    ...previous,
    accessToken: data.access_token,
    // Spotify может выдать новый refresh token, а может оставить прежний.
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

export async function connectSpotify() {
  const clientId = await spotifyClientId();
  if (!clientId) throw Object.assign(new Error("Нужен Client ID Spotify"), { code: "no_client_id" });

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirectUri = spotifyRedirectUri();
  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  const result = await chrome.identity.launchWebAuthFlow({ url: authUrl.href, interactive: true });
  const params = new URL(result).searchParams;
  if (params.get("error")) throw new Error(`Spotify: ${params.get("error")}`);

  const data = await tokenRequest({
    grant_type: "authorization_code",
    code: params.get("code"),
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const record = tokenRecord(data, { clientId });
  const me = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${record.accessToken}` },
  });
  if (me.status === 403) {
    throw new Error("Spotify не пускает этот аккаунт: добавьте его в User Management вашего приложения Spotify");
  }
  const profile = me.ok ? await me.json() : {};
  record.name = profile.display_name || profile.id || "Spotify";
  await setAuth("spotify", record);
  return record.name;
}

export async function spotifyAccessToken() {
  const record = (await getAuth()).spotify;
  if (!record) throw Object.assign(new Error("Spotify не подключён"), { fatal: true });
  if (Date.now() < record.expiresAt) return record.accessToken;
  let data;
  try {
    data = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: record.refreshToken,
      client_id: record.clientId,
    });
  } catch (error) {
    throw Object.assign(new Error("Spotify: вход устарел, подключите сервис заново"), { fatal: true });
  }
  const updated = tokenRecord(data, record);
  await setAuth("spotify", updated);
  return updated.accessToken;
}
