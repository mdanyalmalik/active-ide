// Parses durations used in ledger export schedules.
export function parseDuration(text) {
	const match = /^(\d+)s$/.exec(text.trim());
	if (!match) {
		throw new Error(`Unsupported duration: ${text}`);
	}
	return Number(match[1]) * 1000;
}
