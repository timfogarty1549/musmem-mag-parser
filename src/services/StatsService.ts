class StatsService {
    readonly initializedAt = new Date();
    private articleCount = 0;
    private pageCount = 0;

    incrementArticles(): void {
        this.articleCount++;
    }

    incrementPages(): void {
        this.pageCount++;
    }

    getStats() {
        return {
            initializedAt: this.initializedAt,
            articles: this.articleCount,
            pages: this.pageCount,
        };
    }
}

export default new StatsService();
