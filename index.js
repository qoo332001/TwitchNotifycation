// index.js (服務入口)

const express = require('express');
const { runMonitor, getGlobalState } = require('./monitor'); // 引入核心邏輯

const app = express();
const PORT = process.env.PORT || 8080; // Render 使用 PORT 環境變數

// 定義一個用於 Cloudflare Cron Job 呼叫的檢查端點
app.get('/check', async (req, res) => {
    console.log(`[Endpoint /check] 接收到 Cron Job 請求...`);
    
    // 執行核心監控邏輯 (不強制通知)
    const result = await runMonitor(false); 
    
    // 輸出日誌到 Render Console
    result.log.forEach(line => console.log(line));
    
    if (result.success) {
        res.status(200).json({
            status: 'ok',
            message: 'Twitch 狀態檢查完成。',
            details: result.log,
        });
    } else {
        res.status(500).json({
            status: 'error',
            message: 'Twitch 狀態檢查失敗。',
            details: result.log,
        });
    }
});

// 定義一個手動檢查並強制通知的端點
app.get('/status', async (req, res) => {
    console.log(`[Endpoint /status] 接收到手動檢查請求...`);

    // 執行核心監控邏輯 (強制通知，確保 LINE Bot 能收到測試訊息)
    const result = await runMonitor(true); 
    
    result.log.forEach(line => console.log(line));

    if (result.success) {
        res.status(200).json({
            status: 'ok',
            message: '手動檢查完成，已強制發送通知 (如果實況主開台)。',
            details: result.log,
            current_state: getGlobalState(),
        });
    } else {
        res.status(500).json({
            status: 'error',
            message: '手動檢查失敗。',
            details: result.log,
        });
    }
});

// 啟動伺服器
app.listen(PORT, () => {
    console.log(`🚀 服務已啟動，監聽 Port ${PORT}`);
    console.log(`- Cron Job Endpoint: /check`);
    console.log(`- Manual Status Endpoint: /status`);
});