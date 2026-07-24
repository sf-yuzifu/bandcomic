export function serializeParams(params) {
  const result = {};
  for (const key in params) {
    const value = params[key];
    if (value !== null && typeof value === "object") {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function flattenParams(obj) {
  return serializeParams(obj);
}

export function parseParam(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

export function parseParams(params) {
  const result = {};
  for (const key in params) {
    result[key] = parseParam(params[key]);
  }
  return result;
}
