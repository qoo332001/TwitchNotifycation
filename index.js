// index.js

const express = require('express');
const { runMonitor, getGlobalState } = require('./monitor'); 

const app = express();
const PORT = process.env.PORT || 8080;

// ... (中間的 app.get /check 和 /status 保持不變) ...

// 修改啟動部分：
// 使用 async IIFE (立即執行函式) 來確保先檢查完狀態再啟動 Web Server
(async () => {
    try {
        console.log("🟡 [系統初始化] 正在執行啟動前狀態同步...");
        
        // 參數2 (true) 代表這是「啟動模式」，只同步狀態，不發通知
        const initResult = await runMonitor(false, true); 
        
        if(initResult.success) {
            console.log("🟢 [系統初始化] 狀態同步完成。");
            initResult.log.forEach(l => console.log(l));
        } else {
            console.error("🔴 [系統初始化] 狀態同步失敗，但仍將啟動伺服器。");
        }

    } catch (err) {
        console.error("初始化過程發生錯誤:", err);
    }

    // 狀態同步完後，才開始監聽 Port
    app.listen(PORT, () => {
        console.log(`🚀 服務已啟動，監聽 Port ${PORT}`);
        console.log(`- Cron Job Endpoint: /check`);
        console.log(`- Manual Status Endpoint: /status`);
    });
})();