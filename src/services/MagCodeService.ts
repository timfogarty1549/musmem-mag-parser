import logger from './logger';

class MagCodeService {
    private codes: Record<string, string> = {};

    async initialize(): Promise<void> {
        const maxAttempts = 6;
        const retryDelayMs = 10_000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch('http://localhost:3000/api/mags/codes');
                const json = await response.json() as { success: boolean; data: Record<string, string> };
                if (json.success && json.data) {
                    this.codes = Object.fromEntries(
                        Object.entries(json.data).map(([k, v]) => [k, v.replace(/&amp;/g, '&')])
                    );
                    logger.info(`Loaded ${Object.keys(this.codes).length} magazine codes`);
                    Object.entries(this.codes).forEach(([k, v]) => logger.info(`${k}: ${v}`));
                    return;
                } else {
                    logger.warn(`Magazine code response missing expected data: ${JSON.stringify(json)}`);
                    return;
                }
            } catch (error) {
                if (attempt < maxAttempts) {
                    logger.info(`Magazine codes unavailable (attempt ${attempt}/${maxAttempts}), retrying in ${retryDelayMs / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                } else {
                    logger.warn(`Failed to load magazine codes: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }

    getName(code: string): string | undefined {
        return this.codes[code];
    }
}

export default new MagCodeService();
