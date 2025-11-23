// monitor.js

const axios = require('axios');

// 🚨 模擬狀態持久化：在實際部署中，這個變數會因為伺服器重啟而重置。
// 建議使用 Redis 或 Cloudflare KV 進行狀態持久化。
const GLOBAL_LAST_STATE = {}; 

// --- 配置區 (使用您的值) ---
const TWITCH_CLIENT_ID = 'nnxm2shk3p3k7iri5etuh3hbej1wdk';
const TWITCH_CLIENT_SECRET = 'f56u69hne7spz1rr0e6fjvzumr1wuw'; 
const LINE_CHANNEL_ACCESS_TOKEN = 'd2AWZp9Q9dOzouoChn0ZyUpELGG6Uy9T1G9GEMphHXbl6Mn+xAs0BzBN0APoFdKWq2Qs2Rfp4m+4jSFwoLmBITMBJGFl3yWPkPpz90H1R7k+WZYIMbt3VEqaY19VaExMlutg4TVj83eeIgel4D82jwdB04t89/1O/w1cDnyilFU='; 
const LINE_BROADCAST_URL = 'https://api.line.me/v2/bot/message/broadcast';
const STREAMERS_TO_MONITOR = ['guanweiboy']; 

let TWITCH_ACCESS_TOKEN = null;

// --- 輔助函式：LINE 廣播 ---
// 🚨 修正：新增 displayName 參數，用於內文顯示；streamerLogin 用於連結。
async function sendLineNotification(streamerLogin, streamTitle, displayName = streamerLogin) {
    // 實況主名稱使用 displayName (中文/大小寫)，連結使用 streamerLogin (英文登入名)
    const message = `\n🚨 實況主 ${displayName} 開台了！ 🚨\n標題: ${streamTitle}\n連結: https://twitch.tv/${streamerLogin}`;
    
    const payload = {
        messages: [{
            type: 'text',
            text: message.trim(),
        }],
    };

    try {
        const res = await axios.post(LINE_BROADCAST_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
            },
        });
        
        if (res.status !== 200) {
            console.error(`[Line] ❌ 廣播 API 失敗 (${res.status}): ${JSON.stringify(res.data)}`);
            return false;
        } else {
            console.log(`✅ [通知] LINE 廣播已發送給 ${streamerLogin}`);
            return true;
        }
    } catch (error) {
        console.error("❌ [通知] LINE 廣播請求錯誤:", error.response ? error.response.data : error.message);
        return false;
    }
}

// --- 輔助函式：Twitch 權杖獲取 (保持不變) ---
async function getAccessToken() {
    if (TWITCH_ACCESS_TOKEN) return TWITCH_ACCESS_TOKEN; // 避免重複獲取
    
    const tokenUrl = 'https://id.twitch.tv/oauth2/token';
    try {
        const response = await axios.post(tokenUrl, null, {
            params: {
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }
        });
        TWITCH_ACCESS_TOKEN = response.data.access_token;
        console.log(`✅ 成功取得 Access Token。有效期限: ${response.data.expires_in} 秒`);
        return TWITCH_ACCESS_TOKEN;
    } catch (error) {
        console.error("❌ Twitch 權杖獲取失敗:", error.response ? error.response.data : error.message);
        throw new Error("Twitch Auth Failed");
    }
}

/**
 * @public 供外部呼叫的主監控函式
 * @param {boolean} forceNotify - 是否忽略狀態直接強制通知（用於 /status endpoint）
 * @returns {object} 檢查結果
 */
async function runMonitor(forceNotify = false) {
    const currentTime = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const log = [];
    let notificationSent = false;

    try {
        await getAccessToken(); 
    } catch (e) {
        return { success: false, log: ["無法獲取 Twitch 權杖。"] };
    }
    
    const loginQueries = STREAMERS_TO_MONITOR.map(login => `user_login=${login}`).join('&');
    const streamsUrl = `https://api.twitch.tv/helix/streams?${loginQueries}`;
    
    // 確保所有監控的實況主在 GLOBAL_LAST_STATE 中都有初始狀態
    STREAMERS_TO_MONITOR.forEach(login => {
        if (!GLOBAL_LAST_STATE[login]) {
            GLOBAL_LAST_STATE[login] = { status: 'offline', stream_id: null };
        }
    });
    
    try {
        const response = await axios.get(streamsUrl, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
            }
        });
        
        const liveStreams = response.data.data; 
        const liveLogins = new Set(liveStreams.map(s => s.user_login.toLowerCase()));
        log.push(`[${currentTime}] Twitch API 回應：目前有 ${liveStreams.length} 位實況主正在直播。`);
        
        for (const streamerLogin of STREAMERS_TO_MONITOR) {
            const currentIsLive = liveLogins.has(streamerLogin.toLowerCase());
            const lastState = GLOBAL_LAST_STATE[streamerLogin];
            const liveData = currentIsLive ? liveStreams.find(s => s.user_login.toLowerCase() === streamerLogin.toLowerCase()) : null;

            log.push(`   - [${streamerLogin}] 上次狀態: ${lastState.status}, 當前狀態: ${currentIsLive ? 'online' : 'offline'}`);

            let shouldNotify = false;
            let currentStreamId = null;

            if (currentIsLive) {
                currentStreamId = liveData.id;
                
                // 核心通知邏輯
                if (forceNotify) {
                    shouldNotify = true; // /status 請求強制通知
                    log.push("      *** 強制模式：發送通知 ***");
                } else if (lastState.status === 'offline' || lastState.stream_id !== currentStreamId) {
                    shouldNotify = true; // 狀態轉變，發送通知
                    log.push(`      *** 偵測到開台轉變：${lastState.status} -> online ***`);
                } else {
                    log.push(`      已在直播中，Stream ID: ${currentStreamId}，不重複通知。`);
                }

                if (shouldNotify) {
                    // 🚨 修正：傳入 liveData.user_name 作為顯示名稱
                    await sendLineNotification(streamerLogin, liveData.title, liveData.user_name);
                    notificationSent = true;
                }
                
                // 更新狀態
                GLOBAL_LAST_STATE[streamerLogin].status = 'online';
                GLOBAL_LAST_STATE[streamerLogin].stream_id = currentStreamId;
                
            } else { // 當前未直播 (Offline)
                if (lastState.status === 'online') {
                    log.push(`      *** 偵測到關台轉變：online -> offline ***`);
                }
                // 更新狀態
                GLOBAL_LAST_STATE[streamerLogin].status = 'offline';
                GLOBAL_LAST_STATE[streamerLogin].stream_id = null;
            }
        }
        
        log.push(`--- 輪詢檢查結束 ---`);
        return { success: true, log: log, notificationSent: notificationSent, currentState: GLOBAL_LAST_STATE };

    } catch (error) {
        if (error.response && error.response.status === 401) {
             log.push("🚨 401 錯誤：Twitch Access Token 可能已失效。將重設權杖。");
             TWITCH_ACCESS_TOKEN = null; 
        }
        log.push(`❌ 監控主循環發生錯誤: ${error.message}`);
        return { success: false, log: log };
    }
}

// 導出供 app.js 使用
module.exports = {
    runMonitor,
    getGlobalState: () => GLOBAL_LAST_STATE,
};