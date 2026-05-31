import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

// ============================================
// CONFIGURACIÓN DE CLIENTES
// ============================================

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

const birdeyeClient = axios.create({
    baseURL: 'https://public-api.birdeye.so',
    headers: {
        'x-chain': 'solana',
        'x-api-key': process.env.BIRDEYE_API_KEY
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
// ESTADO DEL BOT
// ============================================

const seenTokens = new Set();
let consecutiveErrors = 0;
let isPollingRunning = false;
let reconnectAttempts = 0;
let isReconnecting = false;

const apiStatus = {
    birdeye: { status: 'active', retryAfter: null, failCount: 0 },
    dexscreener: { status: 'active', failCount: 0 }
};

// ============================================
// SERVIDOR HTTP PARA RENDER (mantiene activo)
// ============================================

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'online', 
            timestamp: new Date().toISOString(),
            polling: isPollingRunning,
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`✅ Servidor HTTP escuchando en puerto ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
});

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
        console.log('📡 Monitoreando conexión en tiempo real...');
        
        // Notificar que el bot está online
        try {
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, 
                '🟢 *HunterNode está en línea!*\n\nBot reiniciado y funcionando correctamente.', 
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.log('⚠️ No se pudo enviar mensaje de inicio (puede ser normal)');
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
// MANEJO DE ERRORES DEL BOT
// ============================================

bot.on('polling_error', async (error) => {
    console.error(`❌ [Polling Error] ${error.message}`);
    
    const recoverableErrors = [
        'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'getaddrinfo', 
        'timeout', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', '403'
    ];
    
    const shouldReconnect = recoverableErrors.some(err => 
        error.message?.includes(err) || error.code === err
    );
    
    if (shouldReconnect && !isReconnecting) {
        console.log('🌐 Error de red detectado, iniciando reconexión automática...');
        isPollingRunning = false;
        setTimeout(() => startBotWithRetry(), 3000);
    }
});

bot.on('webhook_error', (error) => {
    console.error(`❌ [Webhook Error] ${error.message}`);
});

// ============================================
// VERIFICACIÓN DE SEGURIDAD
// ============================================

async function verifyTokenSecurity(tokenAddress) {
    try {
        const response = await rugCheckClient.get(`/tokens/${tokenAddress}/report/summary`);
        const report = response.data;
        
        if (!report || report.score === undefined) {
            console.log(`❌ ${tokenAddress.slice(0,8)}: Sin datos en RugCheck - RECHAZADO`);
            return {
                isSafe: false,
                details: {
                    hasLockedLiquidity: 'Desconocido',
                    freezeAuthorityDisabled: 'Desconocido',
                    mintAuthorityDisabled: 'Desconocido',
                    isHoneypot: false,
                    holderConcentration: '?',
                    noData: true
                }
            };
        }
        
        const hasLockedLiquidity = report.lpBurned > 0 || (report.lockedLiquidity?.length > 0);
        const freezeAuthorityDisabled = report.freezeAuthority === null || report.freezeAuthority === 'disabled';
        const mintAuthorityDisabled = report.mintAuthority === null || report.mintAuthority === 'disabled';
        const isHoneypot = report.honeypotRisk === true;
        const holderConcentration = report.top10HolderPercent || 0;
        
        const isSafe = !isHoneypot && 
                       hasLockedLiquidity && 
                       freezeAuthorityDisabled && 
                       mintAuthorityDisabled &&
                       holderConcentration < 30;
        
        console.log(`🔒 ${tokenAddress.slice(0,8)}: ${isSafe ? '✅ APROBADO' : '❌ RECHAZADO'} | Holders: ${holderConcentration}%`);
        
        return {
            isSafe,
            details: {
                hasLockedLiquidity: hasLockedLiquidity ? '✅ Sí' : '❌ No',
                freezeAuthorityDisabled: freezeAuthorityDisabled ? '✅ Sí' : '❌ No',
                mintAuthorityDisabled: mintAuthorityDisabled ? '✅ Sí' : '❌ No',
                isHoneypot,
                holderConcentration: holderConcentration.toFixed(1)
            }
        };
        
    } catch (error) {
        console.log(`❌ Error RugCheck para ${tokenAddress.slice(0,8)}: ${error.message} - RECHAZADO`);
        return {
            isSafe: false,
            details: {
                hasLockedLiquidity: '❌ Error',
                freezeAuthorityDisabled: '❌ Error',
                mintAuthorityDisabled: '❌ Error',
                isHoneypot: false,
                holderConcentration: '?',
                error: true
            }
        };
    }
}

// ============================================
// OBTENER TOKENS - BIRDEYE
// ============================================

async function fetchTokensFromBirdeye() {
    const response = await birdeyeClient.get('/defi/v3/token/list', {
        params: {
            sort_by: 'volume_24h_usd',
            sort_type: 'desc',
            limit: 15
        }
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

// ============================================
// OBTENER TOKENS - DEXSCREENER
// ============================================

async function fetchTokensFromDexScreener() {
    try {
        const response = await dexscreenerClient.get('/token-profiles/latest/v1');
        
        if (!response.data || !Array.isArray(response.data)) {
            throw new Error('Formato inválido');
        }
        
        const solanaTokens = response.data
            .filter(profile => profile.chainId === 'solana')
            .slice(0, 15);
        
        console.log(`📡 DexScreener: ${solanaTokens.length} tokens de Solana`);
        
        const tokensWithData = [];
        
        for (const profile of solanaTokens) {
            try {
                const searchResponse = await dexscreenerClient.get(`/latest/dex/search?q=${profile.tokenAddress}`);
                
                if (searchResponse.data?.pairs && searchResponse.data.pairs.length > 0) {
                    const pair = searchResponse.data.pairs.find(p => p.chainId === 'solana') || searchResponse.data.pairs[0];
                    
                    if (pair) {
                        tokensWithData.push({
                            address: profile.tokenAddress,
                            symbol: profile.symbol || pair.baseToken?.symbol || 'UNKNOWN',
                            name: profile.name || pair.baseToken?.name || 'Unknown',
                            price: parseFloat(pair.priceUsd) || 0,
                            price_change_1h_percent: pair.priceChange?.h1 || 0,
                            liquidity: pair.liquidity?.usd || 0,
                            volume_24h_usd: pair.volume?.h24 || 0,
                            volume_buy_24h_usd: (pair.volume?.h24 || 0) * 0.55,
                            volume_sell_24h_usd: (pair.volume?.h24 || 0) * 0.45,
                            market_cap: pair.fdv || pair.marketCap || 0
                        });
                        console.log(`  ✅ ${profile.symbol} - $${parseFloat(pair.priceUsd || 0).toFixed(6)}`);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                console.log(`  ❌ Error con ${profile.symbol}: ${error.message}`);
            }
        }
        
        const validTokens = tokensWithData.filter(t => t.liquidity > 20000);
        console.log(`✅ DexScreener: ${validTokens.length} tokens válidos`);
        return validTokens;
        
    } catch (error) {
        console.error(`❌ DexScreener error: ${error.message}`);
        return [];
    }
}

// ============================================
// FALLBACK
// ============================================

async function fetchTokensWithFallback() {
    if (apiStatus.birdeye.retryAfter && Date.now() > apiStatus.birdeye.retryAfter) {
        console.log("🟢 [Birdeye] Reactivando después de cooldown");
        apiStatus.birdeye.status = 'active';
        apiStatus.birdeye.retryAfter = null;
    }
    
    if (apiStatus.birdeye.status !== 'failed') {
        try {
            console.log("📡 [Birdeye] Intentando obtener tokens...");
            const tokens = await fetchTokensFromBirdeye();
            console.log(`✅ [Birdeye] ${tokens.length} tokens obtenidos`);
            consecutiveErrors = 0;
            apiStatus.birdeye.status = 'active';
            return { source: 'birdeye', tokens };
        } catch (error) {
            const status = error.response?.status;
            console.error(`❌ [Birdeye] Error: ${status || error.message}`);
            
            if (status === 400 || error.message?.includes('Compute units')) {
                console.log("⚠️ Límite de CUs alcanzado. Usando DexScreener por 1 hora...");
                apiStatus.birdeye.status = 'failed';
                apiStatus.birdeye.retryAfter = Date.now() + (60 * 60 * 1000);
            }
        }
    }
    
    if (apiStatus.dexscreener.status !== 'failed') {
        try {
            console.log("⚠️ [DexScreener] Usando fallback...");
            const tokens = await fetchTokensFromDexScreener();
            if (tokens.length > 0) {
                apiStatus.dexscreener.status = 'active';
                return { source: 'dexscreener', tokens };
            }
        } catch (error) {
            console.error(`❌ [DexScreener] Error: ${error.message}`);
        }
    }
    
    consecutiveErrors++;
    return { source: null, tokens: [] };
}

// ============================================
// ESCANEO PRINCIPAL
// ============================================

async function scanMemecoins() {
    if (!isPollingRunning) {
        console.log('⏳ Bot no conectado a Telegram, omitiendo escaneo...');
        return;
    }
    
    console.log("\n" + "=".repeat(50));
    console.log(`🔍 ESCANEO - ${new Date().toLocaleTimeString()}`);
    console.log("=".repeat(50));
    
    const { source, tokens } = await fetchTokensWithFallback();
    
    if (!source || tokens.length === 0) {
        console.error("❌ No se pudieron obtener tokens");
        return;
    }
    
    console.log(`📊 Fuente: ${source.toUpperCase()} | ${tokens.length} tokens`);
    
    let alertsSent = 0;
    
    for (const token of tokens) {
        if (seenTokens.has(token.address)) continue;
        if (!token.symbol || token.symbol === 'UNKNOWN') continue;
        
        const hasMinimumLiquidity = token.liquidity > 20000;
        const isMemeCap = token.market_cap < 50000000 && token.market_cap > 5000;
        const isVolatile = Math.abs(token.price_change_1h_percent) > 5;
        
        let buyingPressure = false;
        if (source === 'birdeye') {
            buyingPressure = token.volume_buy_24h_usd > (token.volume_sell_24h_usd * 1.2);
        } else {
            buyingPressure = token.volume_24h_usd > 50000;
        }
        
        if (!hasMinimumLiquidity || !isMemeCap || !isVolatile || !buyingPressure) continue;
        
        console.log(`🔎 Analizando ${token.symbol}...`);
        
        const security = await verifyTokenSecurity(token.address);
        
        if (!security.isSafe) continue;
        
        seenTokens.add(token.address);
        setTimeout(() => seenTokens.delete(token.address), 3600000);
        
        const messageText = `🔥 *HunterNode: Alerta de Alta Calidad*

📈 *${token.symbol}* (${token.name})

💰 *Precio:* $${token.price > 0 ? token.price.toFixed(8) : 'N/A'}
📊 *Cambio 1h:* ${token.price_change_1h_percent > 0 ? '+' : ''}${token.price_change_1h_percent.toFixed(2)}%

🔐 *Seguridad:*
• Liquidez bloqueada: ${security.details.hasLockedLiquidity}
• Freeze authority: ${security.details.freezeAuthorityDisabled}
• Mint authority: ${security.details.mintAuthorityDisabled}
• Top 10 holders: ${security.details.holderConcentration}%

💰 *Mercado:*
• Liquidez: $${Math.floor(token.liquidity).toLocaleString()}
• Volumen 24h: $${Math.floor(token.volume_24h_usd).toLocaleString()}

📑 *Contrato:*
\`${token.address}\`

🔗 [DexScreener](https://dexscreener.com/solana/${token.address}) | [RugCheck](https://rugcheck.xyz/tokens/${token.address}) | [Birdeye](https://birdeye.so/token/${token.address}?chain=solana)`;
        
        try {
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, messageText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${token.address}` },
                            { text: "🔍 RugCheck", url: `https://rugcheck.xyz/tokens/${token.address}` }
                        ],
                        [
                            { text: "🟢 Birdeye", url: `https://birdeye.so/token/${token.address}?chain=solana` },
                            { text: "🟣 Jupiter", url: `https://jup.ag/swap/SOL-${token.address}` }
                        ]
                    ]
                }
            });
            
            alertsSent++;
            console.log(`✅ ALERTA ENVIADA: ${token.symbol}`);
            
        } catch (error) {
            console.error(`❌ Error enviando alerta: ${error.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`📊 Alertas enviadas: ${alertsSent}`);
}

// ============================================
// COMANDOS DE TELEGRAM
// ============================================

bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `🤖 *HunterNode Activado*

🔐 *Filtros:* Liquidez >$20k | Market Cap $5k-$50M | Holders <30% | Anti-honeypot
🔄 *Escaneo:* Cada 2 minutos
📡 *Estado:* ${isPollingRunning ? '✅ Conectado' : '⚠️ Conectando'}

/status - Ver estado detallado`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/status/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `📊 *Estado del Bot*

🔌 *Conexión Telegram:* ${isPollingRunning ? '✅ Activa' : '❌ Desconectada'}
🔄 *Reintentos:* ${reconnectAttempts}
📝 *Tokens en memoria:* ${seenTokens.size}
⏱️ *Tiempo activo:* ${Math.floor(process.uptime())} segundos

🎯 *Modo:* Estricto (100% verificado)`,
        { parse_mode: 'Markdown' }
    );
});

// ============================================
// MANEJO DE ERRORES GLOBALES
// ============================================

process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    if (isPollingRunning) {
        isPollingRunning = false;
        startBotWithRetry();
    }
});

process.on('SIGINT', () => {
    console.log('\n🛑 Cerrando bot...');
    server.close();
    bot.stopPolling().then(() => process.exit(0));
});

// ============================================
// INICIO
// ============================================

console.log("\n" + "=".repeat(50));
console.log("🚀 HUNTERNODE INICIALIZADO - MODO ESTRICTO");
console.log("=".repeat(50));
console.log("✅ Filtros activos: RugCheck | Holders <30% | Liquidez $20k");
console.log("✅ Servidor HTTP activo (para Render)");
console.log("✅ Sistema de autoreconexión: ACTIVADO");
console.log("=".repeat(50) + "\n");

startBotWithRetry();

setTimeout(() => {
    if (isPollingRunning) {
        scanMemecoins();
        setInterval(scanMemecoins, 120000);
    } else {
        console.log('⏳ Esperando conexión...');
        const checkInterval = setInterval(() => {
            if (isPollingRunning) {
                clearInterval(checkInterval);
                scanMemecoins();
                setInterval(scanMemecoins, 600000);
            }
        }, 5000);
    }
}, 5000);