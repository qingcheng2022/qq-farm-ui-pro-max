const { createModuleLogger } = require('./logger');
const { createScheduler } = require('./scheduler');
const { insertReportLog, pruneReportLogs } = require('./database');

const logger = createModuleLogger('report-service');
const REPORT_SCAN_INTERVAL_MS = 60 * 1000;
const REPORT_OPERATION_KEYS = [
    'harvest',
    'water',
    'weed',
    'bug',
    'fertilize',
    'plant',
    'steal',
    'helpWater',
    'helpWeed',
    'helpBug',
    'taskClaim',
    'sell',
    'upgrade',
    'levelUp',
];

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatSlotDate(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatHourSlot(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${formatSlotDate(d)}-${pad2(d.getHours())}`;
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function createEmptyOperations() {
    const operations = {};
    for (const key of REPORT_OPERATION_KEYS) {
        operations[key] = 0;
    }
    return operations;
}

function normalizeSnapshot(statusData) {
    const src = (statusData && typeof statusData === 'object') ? statusData : {};
    const rawOperations = (src.operations && typeof src.operations === 'object') ? src.operations : {};
    const operations = createEmptyOperations();
    for (const key of REPORT_OPERATION_KEYS) {
        operations[key] = Math.max(0, Math.floor(toNumber(rawOperations[key])));
    }
    return {
        sessionExpGained: Math.max(0, toNumber(src.sessionExpGained)),
        sessionGoldGained: Math.max(0, toNumber(src.sessionGoldGained)),
        sessionCouponGained: Math.max(0, toNumber(src.sessionCouponGained)),
        operations,
        recordedAt: Date.now(),
    };
}

function diffSnapshots(current, baseline) {
    const base = (baseline && typeof baseline === 'object') ? baseline : null;
    const result = {
        exp: current.sessionExpGained,
        gold: current.sessionGoldGained,
        coupon: current.sessionCouponGained,
        operations: createEmptyOperations(),
        resetDetected: false,
        hasBaseline: !!base,
    };

    if (!base) {
        for (const key of REPORT_OPERATION_KEYS) {
            result.operations[key] = current.operations[key];
        }
        return result;
    }

    if (
        current.sessionExpGained < toNumber(base.sessionExpGained)
        || current.sessionGoldGained < toNumber(base.sessionGoldGained)
        || current.sessionCouponGained < toNumber(base.sessionCouponGained)
    ) {
        result.resetDetected = true;
        for (const key of REPORT_OPERATION_KEYS) {
            result.operations[key] = current.operations[key];
        }
        return result;
    }

    result.exp = Math.max(0, current.sessionExpGained - toNumber(base.sessionExpGained));
    result.gold = Math.max(0, current.sessionGoldGained - toNumber(base.sessionGoldGained));
    result.coupon = Math.max(0, current.sessionCouponGained - toNumber(base.sessionCouponGained));

    for (const key of REPORT_OPERATION_KEYS) {
        const previous = Math.max(0, Math.floor(toNumber(base.operations && base.operations[key])));
        const now = Math.max(0, Math.floor(toNumber(current.operations[key])));
        if (now < previous) {
            result.resetDetected = true;
            result.operations[key] = now;
        } else {
            result.operations[key] = now - previous;
        }
    }

    return result;
}

function buildModeWindow(mode, now) {
    const end = now instanceof Date ? now : new Date(now || Date.now());
    if (mode === 'hourly') {
        return {
            label: `最近1小时 (${formatDateTime(new Date(end.getTime() - 60 * 60 * 1000))} ~ ${formatDateTime(end)})`,
            slot: formatHourSlot(end),
        };
    }
    if (mode === 'daily') {
        const start = new Date(end);
        start.setHours(0, 0, 0, 0);
        return {
            label: `今日累计 (${formatDateTime(start)} ~ ${formatDateTime(end)})`,
            slot: formatSlotDate(end),
        };
    }
    return {
        label: `当前会话 (${formatDateTime(new Date(end.getTime() - 5 * 60 * 1000))} ~ ${formatDateTime(end)})`,
        slot: '',
    };
}

function getReportHeadline(mode) {
    if (mode === 'hourly') return '小时经营汇报';
    if (mode === 'daily') return '每日经营汇报';
    return '经营汇报测试';
}

function buildOperationSummary(diff) {
    const ops = diff && diff.operations ? diff.operations : {};
    const helpTotal = toNumber(ops.helpWater) + toNumber(ops.helpWeed) + toNumber(ops.helpBug);
    const items = [
        ['收获', ops.harvest],
        ['种植', ops.plant],
        ['浇水', ops.water],
        ['除草', ops.weed],
        ['除虫', ops.bug],
        ['施肥', ops.fertilize],
        ['偷菜', ops.steal],
        ['帮忙', helpTotal],
        ['任务', ops.taskClaim],
        ['出售', ops.sell],
        ['升级', ops.upgrade],
        ['升级到账', ops.levelUp],
    ];
    const parts = items
        .map(([label, value]) => [label, Math.max(0, Math.floor(toNumber(value)))])
        .filter(([, value]) => value > 0)
        .map(([label, value]) => `${label}${value}`);
    return parts.length > 0 ? parts.join(' / ') : '无明显动作';
}

function countCollection(value) {
    if (Array.isArray(value)) return value.length;
    return Math.max(0, Math.floor(toNumber(value)));
}

function summarizeLandsData(landsData) {
    const data = (landsData && typeof landsData === 'object') ? landsData : {};
    const lands = Array.isArray(data.lands) ? data.lands : (Array.isArray(data) ? data : []);
    const summary = (data.summary && typeof data.summary === 'object') ? data.summary : {};
    const total = lands.length;
    const harvestable = countCollection(summary.harvestable || summary.harvestableInfo || summary.harvestableCount);
    const growing = countCollection(summary.growing);
    const empty = countCollection(summary.empty);
    const needWater = countCollection(summary.needWater);
    const needWeed = countCollection(summary.needWeed);
    const needBug = countCollection(summary.needBug);
    const soonToMature = countCollection(summary.soonToMature);
    const upgradable = countCollection(summary.upgradable);
    const unlockable = countCollection(summary.unlockable);
    return `农场概况: 土地${total} / 可收${harvestable} / 生长${growing} / 空地${empty} / 需水${needWater} / 草${needWeed} / 虫${needBug} / 即将成熟${soonToMature} / 可升级${upgradable} / 可解锁${unlockable}`;
}

function summarizeBagData(bagData) {
    const data = (bagData && typeof bagData === 'object') ? bagData : {};
    const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    const totalKinds = Math.max(0, Math.floor(toNumber(data.totalKinds))) || items.length;
    const totalCount = items.reduce((sum, item) => sum + Math.max(0, Math.floor(toNumber(item && item.count))), 0);
    return `背包概况: 物品种类${totalKinds} / 物品总数${totalCount}`;
}

function summarizeFriendsData(friendsData) {
    const list = Array.isArray(friendsData)
        ? friendsData
        : (friendsData && Array.isArray(friendsData.friends) ? friendsData.friends : []);
    const sampleNames = list
        .map(item => String((item && (item.name || item.remark)) || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    const sampleText = sampleNames.length > 0 ? ` / 示例: ${sampleNames.join('、')}` : '';
    return `好友概况: 有效好友${list.length}${sampleText}`;
}

async function collectLiveDetails(accountId, runtimeStatus, dataProvider) {
    const connection = (runtimeStatus && runtimeStatus.connection && typeof runtimeStatus.connection === 'object') ? runtimeStatus.connection : {};
    const details = {
        farmLine: '',
        bagLine: '',
        friendLine: '',
        notes: [],
    };

    if (!connection.connected) {
        details.notes.push('账号离线，已跳过农场/背包/好友详情采集');
        return details;
    }

    const tasks = [
        Promise.resolve().then(() => dataProvider.getLands(accountId)),
        Promise.resolve().then(() => dataProvider.getBag(accountId)),
        Promise.resolve().then(() => dataProvider.getFriends(accountId)),
    ];
    const [landsRes, bagRes, friendsRes] = await Promise.allSettled(tasks);

    if (landsRes.status === 'fulfilled') {
        details.farmLine = summarizeLandsData(landsRes.value);
    } else {
        details.notes.push(`农场详情采集失败: ${landsRes.reason && landsRes.reason.message ? landsRes.reason.message : 'unknown'}`);
    }

    if (bagRes.status === 'fulfilled') {
        details.bagLine = summarizeBagData(bagRes.value);
    } else {
        details.notes.push(`背包详情采集失败: ${bagRes.reason && bagRes.reason.message ? bagRes.reason.message : 'unknown'}`);
    }

    if (friendsRes.status === 'fulfilled') {
        details.friendLine = summarizeFriendsData(friendsRes.value);
    } else {
        details.notes.push(`好友详情采集失败: ${friendsRes.reason && friendsRes.reason.message ? friendsRes.reason.message : 'unknown'}`);
    }

    return details;
}

function buildReportPayload(mode, account, runtimeStatus, diff, cfg, notes = [], liveDetails = {}) {
    const status = (runtimeStatus && runtimeStatus.status && typeof runtimeStatus.status === 'object') ? runtimeStatus.status : {};
    const connection = (runtimeStatus && runtimeStatus.connection && typeof runtimeStatus.connection === 'object') ? runtimeStatus.connection : {};
    const now = new Date();
    const window = buildModeWindow(mode, now);
    const accountName = String((account && (account.name || account.nick)) || status.name || runtimeStatus.accountName || runtimeStatus.accountId || '').trim() || `账号${runtimeStatus.accountId || ''}`;
    const platform = String(status.platform || account.platform || 'qq').trim() || 'qq';
    const connectLabel = connection.connected ? '在线' : '离线';
    const operationSummary = buildOperationSummary(diff);
    const lines = [
        `账号: ${accountName} (${runtimeStatus.accountId || account.id || ''})`,
        `平台: ${platform}`,
        `连接状态: ${connectLabel}`,
        `统计区间: ${window.label}`,
        `本时段收益: 经验 +${Math.max(0, Math.floor(toNumber(diff.exp)))} / 金币 +${Math.max(0, Math.floor(toNumber(diff.gold)))} / 点券 +${Math.max(0, Math.floor(toNumber(diff.coupon)))}`,
        `本时段动作: ${operationSummary}`,
        `当前面板: 等级 ${Math.max(0, Math.floor(toNumber(status.level)))} / 金币 ${Math.max(0, Math.floor(toNumber(status.gold)))} / 经验 ${Math.max(0, Math.floor(toNumber(status.exp)))}`,
        liveDetails.farmLine || '',
        liveDetails.bagLine || '',
        liveDetails.friendLine || '',
        `发送时间: ${formatDateTime(now)}`,
    ].filter(Boolean);
    if (notes.length > 0) {
        lines.push(`备注: ${notes.join('；')}`);
    }
    return {
        title: `${String(cfg.title || '经营汇报').trim()} · ${getReportHeadline(mode)} · ${accountName}`,
        content: lines.join('\n'),
        slot: window.slot,
    };
}

function createReportService(options = {}) {
    const {
        store,
        dataProvider,
        getAccounts,
        sendPushooMessage,
        log,
        addAccountLog,
    } = options;

    const scheduler = createScheduler('account-report-service');
    let started = false;
    let scanning = false;
    let lastRetentionSweepDate = '';

    async function listAccounts() {
        const result = await Promise.resolve(typeof getAccounts === 'function' ? getAccounts() : { accounts: [] });
        if (Array.isArray(result)) return result;
        return Array.isArray(result && result.accounts) ? result.accounts : [];
    }

    function canSendByConfig(cfg) {
        if (!cfg || !cfg.enabled) return false;
        if (!cfg.channel) return false;
        if (cfg.channel === 'webhook') return !!String(cfg.endpoint || '').trim();
        return !!String(cfg.token || '').trim();
    }

    function isHourlyDue(cfg, state, now) {
        if (!cfg.enabled || !cfg.hourlyEnabled) return false;
        if (now.getMinutes() < Math.max(0, Math.min(59, Number.parseInt(cfg.hourlyMinute, 10) || 0))) return false;
        const slot = formatHourSlot(now);
        return String(state.lastHourlySlot || '') !== slot;
    }

    function isDailyDue(cfg, state, now) {
        if (!cfg.enabled || !cfg.dailyEnabled) return false;
        const targetHour = Math.max(0, Math.min(23, Number.parseInt(cfg.dailyHour, 10) || 0));
        const targetMinute = Math.max(0, Math.min(59, Number.parseInt(cfg.dailyMinute, 10) || 0));
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const targetMinutes = targetHour * 60 + targetMinute;
        if (currentMinutes < targetMinutes) return false;
        const slot = formatSlotDate(now);
        return String(state.lastDailySlot || '') !== slot;
    }

    async function pruneHistoryForAccount(accountId, cfg = null) {
        const normalizedAccountId = String(accountId || '').trim();
        if (!normalizedAccountId) {
            return { ok: false, affectedRows: 0, retentionDays: 0 };
        }
        const reportConfig = cfg && typeof cfg === 'object'
            ? cfg
            : (store.getReportConfig ? store.getReportConfig(normalizedAccountId) : null);
        const retentionDays = Math.max(0, Math.min(365, Number.parseInt(reportConfig && reportConfig.retentionDays, 10) || 0));
        if (retentionDays <= 0) {
            return { ok: true, affectedRows: 0, retentionDays };
        }
        try {
            return await pruneReportLogs(normalizedAccountId, { retentionDays });
        } catch (error) {
            logger.warn(`清理经营汇报历史失败(${normalizedAccountId}): ${error && error.message ? error.message : String(error)}`);
            return { ok: false, affectedRows: 0, retentionDays, error: error && error.message ? error.message : String(error) };
        }
    }

    async function runRetentionSweep(now = new Date()) {
        const sweepDate = formatSlotDate(now);
        if (lastRetentionSweepDate === sweepDate) return { ok: true, affectedRows: 0, skipped: true };
        const accounts = await listAccounts();
        let affectedRows = 0;
        try {
            for (const account of accounts) {
                const accountId = String(account && account.id || '').trim();
                if (!accountId) continue;
                const cfg = store.getReportConfig ? store.getReportConfig(accountId) : null;
                if (!cfg) continue;
                const result = await pruneHistoryForAccount(accountId, cfg);
                affectedRows += Number(result && result.affectedRows) || 0;
            }
            lastRetentionSweepDate = sweepDate;
            if (affectedRows > 0) {
                logger.info(`经营汇报历史自动清理完成: 删除 ${affectedRows} 条过期记录`);
            }
            return { ok: true, affectedRows };
        } catch (error) {
            logger.warn(`经营汇报历史定时清理失败: ${error && error.message ? error.message : String(error)}`);
            return { ok: false, affectedRows, error: error && error.message ? error.message : String(error) };
        }
    }

    async function sendReport(accountRef, mode, sendOptions = {}) {
        const accountId = await Promise.resolve(dataProvider.resolveAccountId(accountRef));
        if (!accountId) {
            return { ok: false, error: '账号不存在' };
        }

        const accounts = await listAccounts();
        const account = accounts.find(item => String(item && item.id) === String(accountId)) || { id: accountId };
        const reportConfig = store.getReportConfig ? store.getReportConfig(accountId) : null;
        const reportState = store.getReportState ? store.getReportState(accountId) : {};
        const ignoreEnabled = !!sendOptions.ignoreEnabled;
        const updateState = sendOptions.updateState !== false;

        if (!ignoreEnabled && (!reportConfig || !reportConfig.enabled)) {
            return { ok: false, error: '经营汇报未开启' };
        }

        if (!canSendByConfig({ ...(reportConfig || {}), enabled: true })) {
            return { ok: false, error: '经营汇报推送配置不完整' };
        }

        const runtimeStatus = await Promise.resolve(dataProvider.getStatus(accountId));
        const currentSnapshot = normalizeSnapshot(runtimeStatus);
        const notes = [];
        let diff;
        let nextState = reportState;

        if (mode === 'test') {
            diff = diffSnapshots(currentSnapshot, null);
            notes.push('测试发送不会改写定时汇报基线');
        } else if (mode === 'hourly') {
            diff = diffSnapshots(currentSnapshot, reportState.hourlyBaseline);
            if (diff.resetDetected) notes.push('检测到统计会话重置，本次按当前会话累计值汇报');
            nextState = {
                ...reportState,
                lastHourlySlot: String(sendOptions.slot || formatHourSlot(new Date())).trim(),
                hourlyBaseline: currentSnapshot,
            };
        } else {
            diff = diffSnapshots(currentSnapshot, reportState.dailyBaseline);
            if (diff.resetDetected) notes.push('检测到统计会话重置，本次按当前会话累计值汇报');
            nextState = {
                ...reportState,
                lastDailySlot: String(sendOptions.slot || formatSlotDate(new Date())).trim(),
                dailyBaseline: currentSnapshot,
            };
        }

        const liveDetails = await collectLiveDetails(accountId, runtimeStatus, dataProvider);
        const mergedNotes = [...notes, ...(liveDetails.notes || [])];
        const payload = buildReportPayload(mode, account, runtimeStatus, diff, reportConfig || {}, mergedNotes, liveDetails);
        const delivery = await sendPushooMessage({
            channel: reportConfig.channel,
            endpoint: reportConfig.endpoint,
            token: reportConfig.token,
            title: payload.title,
            content: payload.content,
        });

        try {
            await insertReportLog({
                accountId,
                accountName: account.name || account.nick || runtimeStatus.accountName || runtimeStatus.accountId || '',
                mode,
                ok: !!(delivery && delivery.ok),
                channel: reportConfig.channel,
                title: payload.title,
                content: payload.content,
                errorMessage: delivery && delivery.ok ? '' : String((delivery && delivery.msg) || '发送失败'),
            });
        } catch (e) {
            logger.warn(`记录经营汇报历史失败: ${e && e.message ? e.message : String(e)}`);
        }

        const pruneResult = await pruneHistoryForAccount(accountId, reportConfig);
        if (pruneResult && pruneResult.ok && Number(pruneResult.affectedRows) > 0) {
            logger.info(`${accountId} 经营汇报历史已自动清理 ${pruneResult.affectedRows} 条过期记录`);
        }

        if (delivery && delivery.ok && updateState && store.setReportState) {
            store.setReportState(accountId, nextState);
        }

        if (delivery && delivery.ok) {
            if (typeof addAccountLog === 'function') {
                addAccountLog('report_send', `${getReportHeadline(mode)}发送成功`, accountId, account.name || account.nick || '', { mode });
            }
            if (typeof log === 'function') {
                log('系统', `${account.name || account.nick || accountId} ${getReportHeadline(mode)}发送成功`, {
                    module: 'report',
                    event: 'report_send',
                    accountId: String(accountId),
                    mode,
                });
            }
            return { ok: true, delivery, preview: payload };
        }

        const errorMsg = String((delivery && delivery.msg) || '发送失败');
        if (typeof addAccountLog === 'function') {
            addAccountLog('report_send_failed', `${getReportHeadline(mode)}发送失败: ${errorMsg}`, accountId, account.name || account.nick || '', { mode });
        }
        logger.warn(`${accountId} ${getReportHeadline(mode)}发送失败: ${errorMsg}`);
        return { ok: false, error: errorMsg, delivery, preview: payload };
    }

    async function scanDueReports() {
        if (scanning) return;
        scanning = true;
        try {
            const now = new Date();
            await runRetentionSweep(now);
            const accounts = await listAccounts();
            for (const account of accounts) {
                const accountId = String(account && account.id || '').trim();
                if (!accountId) continue;
                const cfg = store.getReportConfig ? store.getReportConfig(accountId) : null;
                const state = store.getReportState ? store.getReportState(accountId) : {};
                if (!cfg || !cfg.enabled) continue;
                if (!canSendByConfig(cfg)) continue;

                if (isHourlyDue(cfg, state, now)) {
                    await sendReport(accountId, 'hourly', { slot: formatHourSlot(now) });
                }
                if (isDailyDue(cfg, state, now)) {
                    await sendReport(accountId, 'daily', { slot: formatSlotDate(now) });
                }
            }
        } catch (error) {
            logger.warn(`定时扫描经营汇报失败: ${error && error.message ? error.message : String(error)}`);
        } finally {
            scanning = false;
        }
    }

    function start() {
        if (started) return;
        started = true;
        scheduler.setIntervalTask('scan-account-reports', REPORT_SCAN_INTERVAL_MS, scanDueReports, {
            runImmediately: true,
        });
        logger.info('已启动经营汇报定时扫描服务');
    }

    function stop() {
        scheduler.clearAll();
        started = false;
    }

    return {
        start,
        stop,
        sendTestReport: async (accountRef) => await sendReport(accountRef, 'test', { ignoreEnabled: true, updateState: false }),
        sendHourlyReport: async (accountRef) => await sendReport(accountRef, 'hourly'),
        sendDailyReport: async (accountRef) => await sendReport(accountRef, 'daily'),
        scanDueReports,
        runRetentionSweep,
    };
}

module.exports = {
    createReportService,
};
