const RESERVED = ["using", "type", "__proto__", "prototype", "constructor"];
const ID_TYPES = ["numeric", "uuid", "gid_token", "slug", "string"];

export function isSourceKey(key) {
  return typeof key === "string" && key.trim() === key && key.length > 0 && key.length <= 80 &&
    RESERVED.indexOf(key) === -1 && !/[\\/<>\x00-\x1f]/.test(key);
}
export function isBaseUrl(value) {
  // Vela does not guarantee a WHATWG URL implementation.
  if (typeof value !== "string") return false;
  const parsed = value.match(/^https?:\/\/(\[[0-9a-f:]+\]|[^\s/?#:@<>%]+)(?::(\d{1,5}))?(?:\/[^\s?#<>]*)?$/i);
  if (!parsed || /\/(?:\.|\.\.)(?:\/|$)/.test(value)) return false;
  if (parsed[2] && (Number(parsed[2]) < 1 || Number(parsed[2]) > 65535)) return false;
  if (/^\d+(?:\.\d+){3}$/.test(parsed[1]) && parsed[1].split(".").some((part) => Number(part) > 255)) return false;
  return true;
}
export function validateSourceConfig(key, source) {
  if (!isSourceKey(key)) return "key";
  if (!source || typeof source !== "object" || Array.isArray(source)) return "config";
  if (typeof source.name !== "string" || !source.name.trim()) return "name";
  if (!isBaseUrl(source.apiUrl)) return "apiUrl";
  if (source.type != null && typeof source.type !== "string") return "type";
  if (source.idType != null && ID_TYPES.indexOf(source.idType) === -1) return "idType";
  const required = { detailPath: ["id"], photoPath: ["id"], searchPath: ["text", "page"] };
  for (const field of Object.keys(required)) {
    const path = source[field];
    if (typeof path !== "string" || !/^\/(?!\/)/.test(path) || /[\s#\\]/.test(path) ||
        /\/(?:\.|\.\.)(?:\/|\?|$)/.test(path)) return field;
    const placeholders = path.match(/<[^>]*>/g) || [];
    if (placeholders.some((part) => ["<id>", "<chapter>", "<text>", "<page>"].indexOf(part) === -1) ||
        /[<>]/.test(path.replace(/<[^>]*>/g, "")) ||
        required[field].some((name) => path.indexOf("<" + name + ">") === -1)) return field;
  }
  return "";
}
export function validSourceDirectory(directory) {
  if (!directory || typeof directory !== "object" || Array.isArray(directory)) return {};
  const valid = {};
  Object.keys(directory).forEach((key) => {
    if (!validateSourceConfig(key, directory[key])) valid[key] = { ...directory[key], apiUrl: directory[key].apiUrl.replace(/\/+$/, "") };
  });
  return valid;
}
export function isComicId(value, source, key) {
  const text = String(value || "").trim();
  const type = source && (source.idType || source.type) || key || "";
  if (type === "uuid" || /mangadex|manga_dex/i.test(type) || /mangadex|manga_dex/i.test(key || "")) return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(text);
  if (type === "gid_token" || /ehentai|e-hentai/i.test(type) || /e-hentai/i.test(key || "")) return /^\d+_[a-f0-9]{10}$/i.test(text);
  if (type === "slug" || /copymanga|copy_manga/i.test(type) || /copy_manga/i.test(key || "")) return /^[a-z0-9][a-z0-9_-]{1,127}$/i.test(text);
  if (type === "string") return /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(text);
  return /^\d{1,20}$/.test(text);
}
