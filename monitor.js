// monitor.js

const axios = require('axios');
const fs = require('fs');
const STATE_FILE = './stream_state.json';

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return {};
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}


// 🚨 模擬狀態持久化：在實際部署中，這個變數會因為伺服器重啟而重置。
// 建議使用 Redis 或 Cloudflare KV 進行狀態持久化。
let GLOBAL_LAST_STATE = loadState();

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

// monitor.js (部分修改)

// ... (前面的引入和 loadState, saveState, getAccessToken 保持不變) ...

/**
 * @public 供外部呼叫的主監控函式
 * @param {boolean} forceNotify - 是否忽略狀態直接強制通知（用於 /status endpoint）
 * @param {boolean} isStartup - [新增] 是否為系統剛啟動 (只同步狀態，不通知)
 * @returns {object} 檢查結果
 */
async function runMonitor(forceNotify = false, isStartup = false) { // <--- 修改這裡的參數
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
    
    // 初始化狀態物件
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
        
        if (!isStartup) {
            log.push(`[${currentTime}] Twitch API 回應：目前有 ${liveStreams.length} 位實況主正在直播。`);
        } else {
            console.log(`[系統啟動] 正在同步 Twitch 狀態... (目前 ${liveStreams.length} 位直播中)`);
        }
        
        for (const streamerLogin of STREAMERS_TO_MONITOR) {
            const currentIsLive = liveLogins.has(streamerLogin.toLowerCase());
            const lastState = GLOBAL_LAST_STATE[streamerLogin];
            const liveData = currentIsLive ? liveStreams.find(s => s.user_login.toLowerCase() === streamerLogin.toLowerCase()) : null;

            // --- [新增] 系統啟動時的特殊邏輯 ---
            if (isStartup) {
                if (currentIsLive) {
                    // 如果剛啟動時實況主已經在開台，直接將狀態設為 online，但不通知
                    GLOBAL_LAST_STATE[streamerLogin].status = 'online';
                    GLOBAL_LAST_STATE[streamerLogin].stream_id = liveData.id;
                    log.push(`[系統啟動] ${streamerLogin} 已在直播中 (ID: ${liveData.id}) -> 狀態已同步，忽略通知。`);
                } else {
                    GLOBAL_LAST_STATE[streamerLogin].status = 'offline';
                    GLOBAL_LAST_STATE[streamerLogin].stream_id = null;
                }
                continue; // 跳過後面的通知邏輯
            }
            // ----------------------------------

            log.push(`   - [${streamerLogin}] 上次狀態: ${lastState.status}, 當前狀態: ${currentIsLive ? 'online' : 'offline'}`);

            let shouldNotify = false;
            let currentStreamId = null;

            if (currentIsLive) {
                currentStreamId = liveData.id;
                
                // 核心通知邏輯
                if (forceNotify) {
                    shouldNotify = true; 
                    log.push("      *** 強制模式：發送通知 ***");
                } else if (lastState.status === 'offline' || lastState.stream_id !== currentStreamId) {
                    shouldNotify = true; 
                    log.push(`      *** 偵測到開台轉變：${lastState.status} -> online ***`);
                } else {
                    log.push(`      已在直播中，Stream ID: ${currentStreamId}，不重複通知。`);
                }

                if (shouldNotify) {
                    await sendLineNotification(streamerLogin, liveData.title, liveData.user_name);
                    notificationSent = true;
                }
                
                GLOBAL_LAST_STATE[streamerLogin].status = 'online';
                GLOBAL_LAST_STATE[streamerLogin].stream_id = currentStreamId;
                
            } else { // Offline
                if (lastState.status === 'online') {
                    log.push(`      *** 偵測到關台轉變：online -> offline ***`);
                }
                GLOBAL_LAST_STATE[streamerLogin].status = 'offline';
                GLOBAL_LAST_STATE[streamerLogin].stream_id = null;
            }
        }
        
        if (!isStartup) log.push(`--- 輪詢檢查結束 ---`);
        
        // 雖然 Render 存不住，但還是寫一下以防萬一
        saveState(GLOBAL_LAST_STATE); 
        
        return { success: true, log: log, notificationSent: notificationSent, currentState: GLOBAL_LAST_STATE };

    } catch (error) {
        // ... (錯誤處理保持不變) ...
        console.error(error); // 簡單輸出錯誤
        return { success: false, log: log };
    }
}

module.exports = {
    runMonitor,
    getGlobalState: () => GLOBAL_LAST_STATE,
};