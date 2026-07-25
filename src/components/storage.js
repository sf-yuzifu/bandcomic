import file from "@system.file";

export const FILE_ERROR = {
  NOT_FOUND: 301,
  ALREADY_EXISTS: 202,
  ALREADY_EXISTS_NEW_SDK: 13900001,
};

export const COMICS_URI = "internal://files/comics.json";
export const SETTINGS_URI = "internal://files/settings.json";
export const HISTORY_URI = "internal://files/history.json";
export const SOURCES_URI = "internal://files/sources.json";
export const COOKIE_URI = "internal://files/cookie.json";

export function readJsonFile(uri, defaultValue, strict) {
  return new Promise((resolve, reject) => {
    file.readText({
      uri: uri,
      success: (data) => {
        try {
          const parsed = data.text ? JSON.parse(data.text) : defaultValue;
          resolve(parsed == null ? defaultValue : parsed);
        } catch (e) {
          if (strict) {
            reject({ parseError: e });
          } else {
            resolve(defaultValue);
          }
        }
      },
      fail: (data, code) => {
        reject({ data: data, code: code });
      },
    });
  });
}

export function writeJsonFile(uri, value, space) {
  return new Promise((resolve, reject) => {
    file.writeText({
      uri: uri,
      text: JSON.stringify(value, null, space),
      success: () => resolve(),
      fail: (data, code) => {
        reject({ data: data, code: code });
      },
    });
  });
}

export function readComics(strict) {
  return readJsonFile(COMICS_URI, [], strict);
}

export function writeComics(list) {
  return writeJsonFile(COMICS_URI, list);
}

export function readSettings() {
  return readJsonFile(SETTINGS_URI, {});
}

export function writeSettings(settings) {
  return writeJsonFile(SETTINGS_URI, settings);
}

export function readHistory() {
  return readJsonFile(HISTORY_URI, []);
}

export function writeHistory(list) {
  return writeJsonFile(HISTORY_URI, list);
}

export function readSources() {
  return readJsonFile(SOURCES_URI, []);
}

export function writeSources(list) {
  return writeJsonFile(SOURCES_URI, list);
}

export function readCookie() {
  return readJsonFile(COOKIE_URI, {});
}

export function writeCookie(cookie) {
  return writeJsonFile(COOKIE_URI, cookie);
}
