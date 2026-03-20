/**
 * Mygration API Client
 * Thin wrapper around fetch with session cookie handling.
 */
const API = {
    base: '/api/mygration',

    async request(path, options = {}) {
        const url = this.base + path;
        const config = {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        };
        if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
            config.body = JSON.stringify(config.body);
        }
        const res = await fetch(url, config);
        if (res.status === 401) {
            window.location.href = '/login.html';
            return null;
        }
        return res.json();
    },

    get(path) { return this.request(path); },
    post(path, body) { return this.request(path, { method: 'POST', body }); },
    put(path, body) { return this.request(path, { method: 'PUT', body }); },
    del(path) { return this.request(path, { method: 'DELETE' }); },

    // Convenience methods
    async getMe() { return this.get('/me'); },
    async updatePreferences(prefs) { return this.put('/preferences', prefs); },
    async getSpeciesGroups() { return this.get('/species-groups'); },
    async geocode(zip) { return this.get('/geocode?zip=' + encodeURIComponent(zip)); },
    async getDisplayTokens() { return this.get('/display-tokens'); },
    async createDisplayToken(label) { return this.post('/display-tokens', { label }); },
    async deleteDisplayToken(id) { return this.del('/display-tokens/' + id); },
    async logout() { return this.post('/logout'); }
};
