import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

// ============================================
// CONFIGURACIÓN DE CLIENTES
// ============================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const birdeyeApiKey = process.env.BIRDEYE_API_KEY;

if (!token || !chatId) {
    console.error('❌ ERROR: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID son obligatorios');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

const birdeyeClient = axios.create({
    baseURL: 'https://public-api.birdeye.so',
    headers: {
        'x-chain': 'solana',
        'x-api-key': birdeyeApiKey
    },
    timeout: 15000
});

const dexscreenerClient = axios.create({
    baseURL: 'https://api.dexscreener.com',
    timeout: 15000
});

const rugCheckClient = axios.create({
    baseURL: 'https://api.rugcheck.xyz/v1',
    timeout: 15000
});

// ============================================
// SERVIDOR HTTP PARA RENDER (CRÍTICO)
// ============================================

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    console.log(`📡 HTTP request: ${req.method} ${req.url}`);
    
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'online', 
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor HTTP escuchando en puerto ${PORT}`);
    console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
});

// ============================================
// ESTADO DEL BOT
// ============================================

const seenTokens = new Set();
let consecutiveErrors = 0;
let isPollingRunning = false;
let reconnectAttempts = 0;
let isReconnecting = false;
let scanIntervalId = null;

const apiStatus = {
    birdeye: { status: 'active', retryAfter: null, failCount: 0 },
    dexscreener: { status: 'active', failCount: 0 }
};

// ============================================
// FUNCIÓN DE AUTORECONEXIÓN
// ============================================

async function startBotWithRetry() {
    if (isReconnecting) {
        console.log('⚠️ Ya hay un intento de reconexión en curso...');
        return;
    }
    
    isReconnecting = true;
    
    try {
        console.log(`\n🚀 Intentando iniciar bot (intento ${reconnectAttempts + 1})...`);
        
        if (isPollingRunning) {
            console.log('🛑 Deteniendo polling anterior...');
            try {
                await bot.stopPolling();
            } catch (e) {
                // Ignorar
            }
            isPollingRunning = false;
        }
        
        await bot.startPolling({
            timeout: 30,
            retryTimeout: 5000,
            restart: true
        });
        
        isPollingRunning = true;
        reconnectAttempts = 0;
        isReconnecting = false;
        
        console.log('✅ Bot conectado exitosamente a Telegram');
        
        // Enviar mensaje de inicio
        try {
            await bot.sendMessage(chatId, '🟢 *HunterNode está en línea!*\n\nBot reiniciado y funcionando correctamente.', { parse_mode: 'Markdown' });
        } catch (e) {
            console.log('⚠️ No se pudo enviar mensaje de inicio');
        }
        
    } catch (error) {
        isPollingRunning = false;
        isReconnecting = false;
        console.error(`❌ Error iniciando bot: ${error.message}`);
        
        reconnectAttempts++;
        const delay = Math.min(30000, Math.pow(2, reconnectAttempts) * 1000);
        console.log(`⏳ Reintentando conexión en ${delay/1000} segundos...`);
        
        setTimeout(startBotWithRetry, delay);
    }
}

// ============================================
// VERIFICACIÓN DE SEGURIDAD
// ============================================

async function verifyTokenSecurity(tokenAddress) {
    try {
        const response = await rugCheckClient.get(`/tokens/${tokenAddress}/report/summary`);
        const report = response.data;
        
        if (!report || report.score === undefined) {
            console.log(`❌ ${tokenAddress.slice(0,8)}: Sin datos - RECHAZADO`);
            return { isSafe: false, details: {} };
        }
        
        const hasLockedLiquidity = report.lpBurned > 0 || (report.lockedLiquidity?.length > 0);
        const freezeAuthorityDisabled = report.freezeAuthority === null || report.freezeAuthority === 'disabled';
        const mintAuthorityDisabled = report.mintAuthority === null || report.mintAuthority === 'disabled';
        const isHoneypot = report.honeypotRisk === true;
        const holderConcentration = report.top10HolderPercent || 0;
        
        const isSafe = !isHoneypot && hasLockedLiquidity && freezeAuthorityDisabled && mintAuthorityDisabled && holderConcentration < 30;
        
        return {
            isSafe,
            details: {
                hasLockedLiquidity: hasLockedLiquidity ? '✅ Sí' : '❌ No',
                freezeAuthorityDisabled: freezeAuthorityDisabled ? '✅ Sí' : '❌ No',
                mintAuthorityDisabled: mintAuthorityDisabled ? '✅ Sí' : '❌ No',
                holderConcentration: holderConcentration.toFixed(1)
            }
        };
        
    } catch (error) {
        console.log(`❌ Error RugCheck: ${error.message}`);
        return { isSafe: false, details: {} };
    }
}

// ============================================
// OBTENER TOKENS
// ============================================

async function fetchTokensFromBirdeye() {
    const response = await birdeyeClient.get('/defi/v3/token/list', {
        params: { sort_by: 'volume_24h_usd', sort_type: 'desc', limit: 15 }
    });
    const items = response.data?.data?.items || [];
    return items.map(token => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        price: token.price || 0,
        price_change_1h_percent: token.price_change_1h_percent || 0,
        liquidity: token.liquidity || 0,
        volume_24h_usd: token.volume_24h_usd || 0,
        volume_buy_24h_usd: token.volume_buy_24h_usd || 0,
        volume_sell_24h_usd: token.volume_sell_24h_usd || 0,
        market_cap: token.market_cap || 0,
        source: 'birdeye'
    }));
}

async function fetchTokensFromDexScreener() {
    try {
        const response = await dexscreenerClient.get('/token-profiles/latest/v1');
        if (!response.data || !Array.isArray(response.data)) return [];
        
        const solanaTokens = response.data.filter(p => p.chainId === 'solana').slice(0, 15);
        const tokensWithData = [];
        
        for (const profile of solanaTokens) {
            try {
                const searchResponse = await dexscreenerClient.get(`/latest/dex/search?q=${profile.tokenAddress}`);
                if (searchResponse.data?.pairs?.length > 0) {
                    const pair = searchResponse.data.pairs.find(p => p.chainId === 'solana') || searchResponse.data.pairs[0];
                    if (pair && pair.liquidity?.usd > 20000) {
                        tokensWithData.push({
                            address: profile.tokenAddress,
                            symbol: profile.symbol || pair.baseToken?.symbol || 'UNKNOWN',
                            name: profile.name || pair.baseToken?.name || 'Unknown',
                            price: parseFloat(pair.priceUsd) || 0,
                            price_change_1h_percent: pair.priceChange?.h1 || 0,
                            liquidity: pair.liquidity?.usd || 0,
                            volume_24h_usd: pair.volume?.h24 || 0,
                            market_cap: pair.fdv || pair.marketCap || 0,
                            source: 'dexscreener'
                        });
                    }
                }
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {}
        }
        return tokensWithData;
    } catch (error) {
        return [];
    }
}

async function fetchTokensWithFallback() {
    if (apiStatus.birdeye.status !== 'failed') {
        try {
            const tokens = await fetchTokensFromBirdeye();
            if (tokens.length) return { source: 'birdeye', tokens };
        } catch (error) {
            if (error.response?.status === 400) {
                apiStatus.birdeye.status = 'failed';
                apiStatus.birdeye.retryAfter = Date.now() + 3600000;
            }
        }
    }
    
    const tokens = await fetchTokensFromDexScreener();
    return { source: tokens.length ? 'dexscreener' : null, tokens };
}

// ============================================
// ESCANEO PRINCIPAL
// ============================================

async function scanMemecoins() {
    if (!isPollingRunning) {
        console.log('⏳ Bot no conectado, omitiendo escaneo...');
        return;
    }
    
    console.log(`\n🔍 ESCANEO - ${new Date().toLocaleTimeString()}`);
    
    const { source, tokens } = await fetchTokensWithFallback();
    if (!source || tokens.length === 0) return;
    
    console.log(`📊 Fuente: ${source} | ${tokens.length} tokens`);
    
    for (const token of tokens) {
        if (seenTokens.has(token.address)) continue;
        if (!token.symbol || token.symbol === 'UNKNOWN') continue;
        
        const hasLiquidity = token.liquidity > 20000;
        const isMeme = token.market_cap < 50000000 && token.market_cap > 5000;
        const isVolatile = Math.abs(token.price_change_1h_percent) > 5;
        
        if (!hasLiquidity || !isMeme || !isVolatile) continue;
        
        console.log(`🔎 Analizando ${token.symbol}...`);
        
        const security = await verifyTokenSecurity(token.address);
        if (!security.isSafe) continue;
        
        seenTokens.add(token.address);
        setTimeout(() => seenTokens.delete(token.address), 3600000);
        
        const message = `🔥 *HunterNode: Alerta*

📈 *${token.symbol}* (${token.name})
💰 Precio: $${token.price.toFixed(8)}
📊 Cambio 1h: ${token.price_change_1h_percent > 0 ? '+' : ''}${token.price_change_1h_percent.toFixed(2)}%

🔐 Seguridad:
• Liquidez bloqueada: ${security.details.hasLockedLiquidity}
• Holders top10: ${security.details.holderConcentration}%

💰 Liquidez: $${Math.floor(token.liquidity).toLocaleString()}

📑 \`${token.address}\`

[📊 DexScreener](https://dexscreener.com/solana/${token.address}) | [🔍 RugCheck](https://rugcheck.xyz/tokens/${token.address})`;
        
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        console.log(`✅ Alerta enviada: ${token.symbol}`);
        await new Promise(r => setTimeout(r, 2000));
    }
}

// ============================================
// COMANDOS
// ============================================

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🤖 *HunterNode Activado*\n\nFiltros: Liquidez $20k | Holders <30% | Anti-honeypot\n\n/status - Ver estado', { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
    bot.sendMessage(msg.chat.id, `📊 *Estado*\n\nConexión: ${isPollingRunning ? '✅ Activa' : '❌ Desconectada'}\nTokens vistos: ${seenTokens.size}\nModo: Estricto`, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (error) => {
    console.error(`❌ Polling error: ${error.message}`);
    if (error.message.includes('409') && !isReconnecting) {
        console.log('⚠️ Conflicto detectado, reconectando...');
        isPollingRunning = false;
        setTimeout(startBotWithRetry, 5000);
    }
});

// ============================================
// INICIO
// ============================================

console.log("\n🚀 HUNTERNODE INICIALIZADO");
console.log(`✅ Puerto: ${PORT}`);
console.log("✅ Modo estricto activado\n");

startBotWithRetry();

setTimeout(() => {
    if (isPollingRunning) {
        scanMemecoins();
        setInterval(scanMemecoins, 600000);
    }
}, 10000);