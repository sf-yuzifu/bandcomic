export function safeJsonParse(text, defaultValue) {
	if (typeof text !== "string" || !text) {
		return defaultValue;
	}
	try {
		const parsed = JSON.parse(text);
		return parsed == null ? defaultValue : parsed;
	} catch (e) {
		return defaultValue;
	}
}
