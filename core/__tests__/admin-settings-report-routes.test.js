const test = require('node:test');
const assert = require('node:assert/strict');

const { registerSettingsReportRoutes } = require('../src/controllers/admin/settings-report-routes');

function createFakeApp() {
    const routes = { get: new Map(), post: new Map(), delete: new Map() };
    return {
        routes,
        app: {
            get(path, ...handlers) {
                routes.get.set(path, handlers);
            },
            post(path, ...handlers) {
                routes.post.set(path, handlers);
            },
            delete(path, ...handlers) {
                routes.delete.set(path, handlers);
            },
        },
    };
}

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
            return this;
        },
    };
}

function getRouteHandlers(routes, method, path) {
    const handlers = routes[method].get(path);
    assert.ok(handlers, `missing route: ${method.toUpperCase()} ${path}`);
    return handlers;
}

function getRouteParts(routes, method, path) {
    const handlers = getRouteHandlers(routes, method, path);
    const middleware = handlers.length > 1 ? handlers[0] : null;
    const handler = handlers[handlers.length - 1];
    assert.equal(typeof handler, 'function');
    if (middleware) {
        assert.equal(typeof middleware, 'function');
    }
    return { middleware, handler };
}

function createDeps(overrides = {}) {
    const authRequired = (_req, _res, next) => next && next();
    const accountOwnershipRequired = (_req, _res, next) => next && next();
    const store = {
        getUI: () => ({ theme: 'light', siteTitle: '全局标题', colorTheme: 'emerald' }),
        applyConfigSnapshot: () => {},
        flushGlobalConfigSave: async () => {},
        getTimingConfig: () => ({ farmLoop: 30 }),
        DEFAULT_TIMING_CONFIG: { farmLoop: 60 },
        setTimingConfig: (body) => body,
        setOfflineReminder: (body) => body,
    };

    return {
        authRequired,
        accountOwnershipRequired,
        getAccId: async () => 'acc-1',
        getAccountsSnapshot: async () => ({ accounts: [{ id: 'acc-1', username: 'tester' }, { id: 'acc-2', username: 'other' }] }),
        resolveAccId: async (id) => String(id || '').trim(),
        getProvider: () => ({
            setUITheme: async () => {},
            sendAccountReportTest: async () => ({ ok: true }),
            sendAccountReport: async () => ({ ok: true }),
        }),
        store,
        adminLogger: { info: () => {} },
        buildUserUiBody: (body) => body,
        getUserPreferences: async () => ({
            currentAccountId: 'acc-1',
            accountsViewState: null,
            accountsActionHistory: null,
            dashboardViewState: null,
            analyticsViewState: null,
            reportHistoryViewState: null,
            cardsViewState: null,
            systemLogsViewState: null,
        }),
        getUserUiConfig: async () => ({}),
        mergeUiConfig: (globalUi, userUi) => ({ ...globalUi, ...userUi }),
        saveUserUiConfig: async (_username, nextUi) => nextUi,
        saveUserPreferences: async (_username, nextPreferences) => nextPreferences,
        runUiBackgroundCleanup: () => {},
        ensureUiBackgroundDir: () => '/tmp',
        buildReportHistoryCsv: (items) => JSON.stringify(items),
        getReportLogs: async () => ({ items: [], total: 0 }),
        getReportLogStats: async () => ({ total: 0 }),
        exportReportLogs: async () => ({ items: [], total: 0, truncated: false }),
        deleteReportLogsByIds: async (_id, ids) => ({ deleted: ids.length }),
        clearReportLogs: async () => ({ deleted: 0 }),
        crypto: { randomBytes: () => Buffer.from('1234') },
        fs: { writeFileSync: () => {} },
        path: { join: (...parts) => parts.join('/') },
        app: null,
        ...overrides,
    };
}

test('theme route saves per-user ui without touching global config path', async () => {
    const { app, routes } = createFakeApp();
    const calls = [];
    const deps = createDeps({
        app,
        store: {
            getUI: () => ({ theme: 'light', siteTitle: '全局标题', colorTheme: 'emerald' }),
        },
        getUserUiConfig: async () => ({ siteTitle: '旧个人标题' }),
        buildUserUiBody: (body) => ({ siteTitle: body.siteTitle }),
        saveUserUiConfig: async (...args) => {
            calls.push(args);
            return { siteTitle: '新个人标题', colorTheme: 'emerald' };
        },
    });

    registerSettingsReportRoutes(deps);
    const { middleware, handler } = getRouteParts(routes, 'post', '/api/settings/theme');
    assert.equal(middleware, null);

    const res = createResponse();
    await handler(
        {
            body: { siteTitle: '新个人标题' },
            currentUser: { username: 'tester', role: 'user' },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [[
        'tester',
        { theme: 'light', siteTitle: '新个人标题', colorTheme: 'emerald' },
        { theme: 'light', siteTitle: '旧个人标题', colorTheme: 'emerald' },
    ]]);
    assert.deepEqual(res.body, {
        ok: true,
        data: { theme: 'light', siteTitle: '新个人标题', colorTheme: 'emerald' },
    });
});

test('account selection route keeps auth middleware and persists owned account selection', async () => {
    const { app, routes } = createFakeApp();
    const calls = [];
    const deps = createDeps({
        app,
        saveUserPreferences: async (...args) => {
            calls.push(args);
            return { currentAccountId: 'acc-1' };
        },
    });

    registerSettingsReportRoutes(deps);
    const { middleware, handler } = getRouteParts(routes, 'post', '/api/account-selection');
    assert.equal(middleware, deps.authRequired);

    const res = createResponse();
    await handler(
        {
            body: { currentAccountId: 'acc-1' },
            currentUser: { username: 'tester', role: 'user' },
        },
        res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [['tester', { currentAccountId: 'acc-1' }]]);
    assert.deepEqual(res.body, {
        ok: true,
        data: { currentAccountId: 'acc-1' },
    });
});

test('view preferences routes keep auth middleware and save partial page state', async () => {
    const { app, routes } = createFakeApp();
    const calls = [];
    const deps = createDeps({
        app,
        getUserPreferences: async () => ({
            currentAccountId: 'acc-9',
            announcementDismissedId: '12',
            notificationLastReadDate: '2026-03-10 08:30:00',
            appSeenVersion: 'v1.0.0',
            accountsViewState: {
                viewMode: 'table',
                tableSortKey: 'owner',
                tableSortDirection: 'asc',
                tableColumnVisibility: {
                    owner: true,
                    platform: false,
                    activity: true,
                    mode: true,
                    state: true,
                    actions: false,
                },
            },
            accountsActionHistory: [{
                id: 'history-1',
                actionLabel: '批量启动',
                status: 'warning',
                timestamp: 1741593600000,
                totalCount: 4,
                successCount: 3,
                failedCount: 1,
                skippedCount: 0,
                affectedNames: ['账号A', '账号B'],
                failedNames: ['账号C'],
                targetLabel: '当前筛选：4 项',
            }],
            dashboardViewState: {
                module: 'farm',
                event: 'harvest_crop',
                keyword: '收获',
                isWarn: 'warn',
            },
            analyticsViewState: {
                sortKey: 'profit',
                strategyPanelCollapsed: true,
            },
            reportHistoryViewState: {
                mode: 'daily',
                status: 'failed',
                keyword: '邮件',
                sortOrder: 'asc',
                pageSize: 50,
            },
            cardsViewState: { keyword: 'trial', page: 2, pageSize: 20, type: 'all', status: 'all', source: 'all', batchNo: 'all', createdBy: 'all' },
            systemLogsViewState: { level: 'warn', accountId: '', keyword: 'worker', page: 3, pageSize: 20 },
        }),
        saveUserPreferences: async (...args) => {
            calls.push(args);
            return {
                currentAccountId: 'acc-9',
                announcementDismissedId: '18',
                notificationLastReadDate: '2026-03-10 09:00:00',
                appSeenVersion: 'v1.0.1',
                accountsViewState: {
                    viewMode: 'compact',
                    tableSortKey: 'platform',
                    tableSortDirection: 'desc',
                    tableColumnVisibility: {
                        owner: true,
                        platform: true,
                        activity: true,
                        mode: true,
                        state: false,
                        actions: true,
                    },
                },
                accountsActionHistory: [{
                    id: 'history-2',
                    actionLabel: '批量导出',
                    status: 'success',
                    timestamp: 1741597200000,
                    totalCount: 2,
                    successCount: 2,
                    failedCount: 0,
                    skippedCount: 0,
                    affectedNames: ['账号D', '账号E'],
                    failedNames: [],
                    targetLabel: '视图：表格',
                }],
                dashboardViewState: {
                    module: 'system',
                    event: '',
                    keyword: '错误',
                    isWarn: 'warn',
                },
                analyticsViewState: {
                    sortKey: 'level',
                    strategyPanelCollapsed: false,
                },
                reportHistoryViewState: {
                    mode: 'hourly',
                    status: 'success',
                    keyword: '',
                    sortOrder: 'desc',
                    pageSize: 20,
                },
                cardsViewState: { keyword: 'trial', page: 2, pageSize: 20, type: 'all', status: 'all', source: 'all', batchNo: 'all', createdBy: 'all' },
                systemLogsViewState: { level: 'error', accountId: 'acc-1', keyword: '', page: 1, pageSize: 20 },
            };
        },
    });

    registerSettingsReportRoutes(deps);

    const getRoute = getRouteParts(routes, 'get', '/api/view-preferences');
    assert.equal(getRoute.middleware, deps.authRequired);
    const getRes = createResponse();
    await getRoute.handler({ currentUser: { username: 'tester', role: 'user' } }, getRes);
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(getRes.body, {
        ok: true,
        data: {
            announcementDismissedId: '12',
            notificationLastReadDate: '2026-03-10 08:30:00',
            appSeenVersion: 'v1.0.0',
            accountsViewState: {
                viewMode: 'table',
                tableSortKey: 'owner',
                tableSortDirection: 'asc',
                tableColumnVisibility: {
                    owner: true,
                    platform: false,
                    activity: true,
                    mode: true,
                    state: true,
                    actions: false,
                },
            },
            accountsActionHistory: [{
                id: 'history-1',
                actionLabel: '批量启动',
                status: 'warning',
                timestamp: 1741593600000,
                totalCount: 4,
                successCount: 3,
                failedCount: 1,
                skippedCount: 0,
                affectedNames: ['账号A', '账号B'],
                failedNames: ['账号C'],
                targetLabel: '当前筛选：4 项',
            }],
            dashboardViewState: {
                module: 'farm',
                event: 'harvest_crop',
                keyword: '收获',
                isWarn: 'warn',
            },
            analyticsViewState: {
                sortKey: 'profit',
                strategyPanelCollapsed: true,
            },
            reportHistoryViewState: {
                mode: 'daily',
                status: 'failed',
                keyword: '邮件',
                sortOrder: 'asc',
                pageSize: 50,
            },
            cardsViewState: { keyword: 'trial', page: 2, pageSize: 20, type: 'all', status: 'all', source: 'all', batchNo: 'all', createdBy: 'all' },
            systemLogsViewState: { level: 'warn', accountId: '', keyword: 'worker', page: 3, pageSize: 20 },
        },
    });

    const postRoute = getRouteParts(routes, 'post', '/api/view-preferences');
    assert.equal(postRoute.middleware, deps.authRequired);
    const postRes = createResponse();
    await postRoute.handler({
        body: {
            announcementDismissedId: '18',
            notificationLastReadDate: '2026-03-10 09:00:00',
            appSeenVersion: 'v1.0.1',
            accountsViewState: {
                viewMode: 'compact',
                tableSortKey: 'platform',
                tableSortDirection: 'desc',
                tableColumnVisibility: {
                    owner: true,
                    platform: true,
                    activity: true,
                    mode: true,
                    state: false,
                    actions: true,
                },
            },
            accountsActionHistory: [{
                id: 'history-2',
                actionLabel: '批量导出',
                status: 'success',
                timestamp: 1741597200000,
                totalCount: 2,
                successCount: 2,
                failedCount: 0,
                skippedCount: 0,
                affectedNames: ['账号D', '账号E'],
                failedNames: [],
                targetLabel: '视图：表格',
            }],
            dashboardViewState: {
                module: 'system',
                event: '',
                keyword: '错误',
                isWarn: 'warn',
            },
            analyticsViewState: {
                sortKey: 'level',
                strategyPanelCollapsed: false,
            },
            reportHistoryViewState: {
                mode: 'hourly',
                status: 'success',
                keyword: '',
                sortOrder: 'desc',
                pageSize: 20,
            },
            systemLogsViewState: { level: 'error', accountId: 'acc-1', keyword: '', page: 1, pageSize: 20 },
        },
        currentUser: { username: 'tester', role: 'user' },
    }, postRes);

    assert.equal(postRes.statusCode, 200);
    assert.deepEqual(calls, [[
        'tester',
            {
                announcementDismissedId: '18',
                notificationLastReadDate: '2026-03-10 09:00:00',
                appSeenVersion: 'v1.0.1',
                accountsViewState: {
                    viewMode: 'compact',
                tableSortKey: 'platform',
                tableSortDirection: 'desc',
                tableColumnVisibility: {
                    owner: true,
                    platform: true,
                    activity: true,
                    mode: true,
                    state: false,
                        actions: true,
                    },
                },
                dashboardViewState: {
                    module: 'system',
                    event: '',
                    keyword: '错误',
                    isWarn: 'warn',
                },
                analyticsViewState: {
                    sortKey: 'level',
                    strategyPanelCollapsed: false,
                },
                reportHistoryViewState: {
                    mode: 'hourly',
                    status: 'success',
                    keyword: '',
                    sortOrder: 'desc',
                    pageSize: 20,
                },
                accountsActionHistory: [{
                    id: 'history-2',
                    actionLabel: '批量导出',
                    status: 'success',
                    timestamp: 1741597200000,
                    totalCount: 2,
                    successCount: 2,
                    failedCount: 0,
                    skippedCount: 0,
                    affectedNames: ['账号D', '账号E'],
                    failedNames: [],
                    targetLabel: '视图：表格',
                }],
                cardsViewState: undefined,
                systemLogsViewState: { level: 'error', accountId: 'acc-1', keyword: '', page: 1, pageSize: 20 },
            },
    ]]);
    assert.deepEqual(postRes.body, {
        ok: true,
        data: {
            announcementDismissedId: '18',
            notificationLastReadDate: '2026-03-10 09:00:00',
            appSeenVersion: 'v1.0.1',
            accountsViewState: {
                viewMode: 'compact',
                tableSortKey: 'platform',
                tableSortDirection: 'desc',
                tableColumnVisibility: {
                    owner: true,
                    platform: true,
                    activity: true,
                    mode: true,
                    state: false,
                    actions: true,
                },
            },
            dashboardViewState: {
                module: 'system',
                event: '',
                keyword: '错误',
                isWarn: 'warn',
            },
            analyticsViewState: {
                sortKey: 'level',
                strategyPanelCollapsed: false,
            },
            reportHistoryViewState: {
                mode: 'hourly',
                status: 'success',
                keyword: '',
                sortOrder: 'desc',
                pageSize: 20,
            },
            accountsActionHistory: [{
                id: 'history-2',
                actionLabel: '批量导出',
                status: 'success',
                timestamp: 1741597200000,
                totalCount: 2,
                successCount: 2,
                failedCount: 0,
                skippedCount: 0,
                affectedNames: ['账号D', '账号E'],
                failedNames: [],
                targetLabel: '视图：表格',
            }],
            cardsViewState: { keyword: 'trial', page: 2, pageSize: 20, type: 'all', status: 'all', source: 'all', batchNo: 'all', createdBy: 'all' },
            systemLogsViewState: { level: 'error', accountId: 'acc-1', keyword: '', page: 1, pageSize: 20 },
        },
    });
});

test('timing-config route keeps auth middleware and blocks non-admin users', async () => {
    const { app, routes } = createFakeApp();
    const deps = createDeps({ app });

    registerSettingsReportRoutes(deps);
    const { middleware, handler } = getRouteParts(routes, 'get', '/api/settings/timing-config');
    assert.equal(middleware, deps.authRequired);

    const res = createResponse();
    await handler({ currentUser: { username: 'tester', role: 'user' } }, res);

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, error: 'Forbidden' });
});

test('report export route keeps account middleware and returns csv headers', async () => {
    const { app, routes } = createFakeApp();
    const deps = createDeps({
        app,
        getAccId: async () => 'acc:1',
        exportReportLogs: async () => ({
            items: [{ id: 1, status: 'success' }],
            total: 3,
            truncated: true,
        }),
        buildReportHistoryCsv: () => 'csv-body',
    });

    registerSettingsReportRoutes(deps);
    const { middleware, handler } = getRouteParts(routes, 'get', '/api/reports/history/export');
    assert.equal(middleware, deps.accountOwnershipRequired);

    const res = createResponse();
    await handler({ query: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'csv-body');
    assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.match(res.headers['Content-Disposition'], /^attachment; filename="report-history-acc_1-\d+\.csv"$/);
    assert.equal(res.headers['X-Export-Count'], '1');
    assert.equal(res.headers['X-Export-Total'], '3');
    assert.equal(res.headers['X-Export-Truncated'], '1');
});

test('report test route returns service unavailable when provider is missing', async () => {
    const { app, routes } = createFakeApp();
    const deps = createDeps({
        app,
        getProvider: () => null,
    });

    registerSettingsReportRoutes(deps);
    const { middleware, handler } = getRouteParts(routes, 'post', '/api/reports/test');
    assert.equal(middleware, deps.accountOwnershipRequired);

    const res = createResponse();
    await handler({ body: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, error: '经营汇报服务未启动' });
});
