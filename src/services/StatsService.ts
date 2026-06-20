class StatsService {
    readonly initializedAt = new Date();
    private articleCount = 0;

    incrementArticles(): void {
        this.articleCount++;
    }

    getStats() {
        return {
            initializedAt: this.initializedAt,
            articles: this.articleCount,
        };
    }
}

export default new StatsService();
