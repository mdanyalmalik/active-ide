// Minimal client for the ledger HTTP API.
export class ApiClient {
	constructor(baseUrl, fetchImpl = fetch) {
		this.baseUrl = baseUrl;
		this.fetchImpl = fetchImpl;
	}

	async getBalance(accountId) {
		const response = await this.fetchImpl(`${this.baseUrl}/accounts/${accountId}/balance`);
		if (!response.ok) {
			throw new Error(`Balance request failed: ${response.status}`);
		}
		return response.json();
	}

	async listTransactions(accountId, page = 1) {
		const response = await this.fetchImpl(`${this.baseUrl}/accounts/${accountId}/transactions?page=${page}`);
		if (!response.ok) {
			throw new Error(`Transactions request failed: ${response.status}`);
		}
		return response.json();
	}
}
