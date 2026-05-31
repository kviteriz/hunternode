import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

// ============================================
// CONFIGURACIÓN DE CLIENTES
// ============================================

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false }); // polling: false para control manual

const birdeyeClient = axios.create({
    baseURL: 'https://public-api.birdeye.so',
    headers: {
        'x-chain': 'solana',
        'x-api-key': process.env.BIRDEYE_API_KEY
    },
    timeout: 10000
});

const dexscreenerClient = axios.create({
    baseURL: 'https://api.dexscreener.com',
    timeout: 10000
});

const rugCheckClient = axios.create({
    baseURL: 'https://api.rugcheck.xyz/v1',
    timeout: 10000
});

// ============================================
// ESTADO DEL BOT Y CONTROL DE RECONEXIÓN
// ============================================

const seenTokens = new Set();
let consecutiveErrors = 0;
let isPollingRunning = false;
let reconnectAttempts = 0;
let scanInterval = null;
let isReconnecting = false;

const apiStatus = {
    birdeye: { status: 'active', retryAfter: null, failCount: 0 },
    dexscreener: { status: 'active', failCount: 0 }
};

// ============================================
// FUNCIÓN DE AUTORECONEXIÓN DEL BOT
// ============================================

async function startBotWithRetry() {
    if (isReconnecting) {
        console.log('⚠️ Ya hay un intento de reconexión en curso...');
        return;
    }
    
    isReconnecting = true;
    
    try {
        console.log(`\n🚀 Intentando iniciar bot (intento ${reconnectAttempts + 1})...`);
        
        // Detener polling si está corriendo
        if (isPollingRunning) {
            console.log('🛑 Deteniendo polling anterior...');
            try {
                await bot.stopPolling();
            } catch (e) {
                // Ignorar errores al detener
            }
            isPollingRunning = false;
        }
        
        // Iniciar polling con opciones robustas
        await bot.startPolling({
            timeout: 30,           // Timeout más corto para detectar fallos rápido
            retryTimeout: 5000,    // Reintentar cada 5 segundos internamente
            restart: true          // Intentar reinicio automático interno
        });
        
        isPollingRunning = true;
        reconnectAttempts = 0;     // Resetear contador en éxito
        isReconnecting = false;
        
        console.log('✅ Bot conectado exitosamente a Telegram');
        console.log('📡 Monitoreando conexión en tiempo real...\n');
        
    } catch (error) {
        isPollingRunning = false;
        isReconnecting = false;
        console.error(`❌ Error iniciando bot: ${error.message}`);
        
        // Reintentar con backoff exponencial (máximo 30 segundos)
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
    
    // Errores recuperables que requieren reconexión
    const recoverableErrors = [
        'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'getaddrinfo', 
        'timeout', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'
    ];
    
    const shouldReconnect = recoverableErrors.some(err => 
        error.message?.includes(err) || error.code === err
    );
    
    if (shouldReconnect && !isReconnecting) {
        console.log('🌐 Error de red detectado, iniciando reconexión automática...');
        isPollingRunning = false;
        
        // Pequeño delay antes de reconectar
        setTimeout(() => {
            startBotWithRetry();
        }, 3000);
    }
});

bot.on('webhook_error', (error) => {
    console.error(`❌ [Webhook Error] ${error.message}`);
});

// ============================================
// VERIFICACIÓN DE SEGURIDAD (MODO ESTRICTO)
// ============================================

async function verifyTokenSecurity(tokenAddress) {
    try {
        const response = await rugCheckClient.get(`/tokens/${tokenAddress}/report/summary`);
        const report = response.data;
        
        // Si no hay datos, RECHAZAR el token
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
        
        // FILTROS ESTRICTOS
        const isSafe = !isHoneypot && 
                       hasLockedLiquidity && 
                       freezeAuthorityDisabled && 
                       mintAuthorityDisabled &&
                       holderConcentration < 30;
        
        console.log(`🔒 ${tokenAddress.slice(0,8)}: ${isSafe ? '✅ APROBADO' : '❌ RECHAZADO'} | Holders: ${holderConcentration}% | Honeypot: ${isHoneypot} | Liquidez bloqueada: ${hasLockedLiquidity}`);
        
        return {
            isSafe,
            details: {
                hasLockedLiquidity: hasLockedLiquidity ? '✅ Sí' : '❌ No',
                freezeAuthorityDisabled: freezeAuthorityDisabled ? '✅ Sí' : '❌ No',
                mintAuthorityDisabled: mintAuthorityDisabled ? '✅ Sí' : '❌ No',
                isHoneypot,
                holderConcentration: holderConcentration.toFixed(1),
                securityScore: report.score || 0
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
                } else {
                    tokensWithData.push({
                        address: profile.tokenAddress,
                        symbol: profile.symbol || 'UNKNOWN',
                        name: profile.name || 'Unknown',
                        price: 0,
                        price_change_1h_percent: 0,
                        liquidity: 0,
                        volume_24h_usd: 0,
                        volume_buy_24h_usd: 0,
                        volume_sell_24h_usd: 0,
                        market_cap: 0
                    });
                    console.log(`  ⚠️ ${profile.symbol} - Sin datos de trading`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                console.log(`  ❌ Error con ${profile.symbol}: ${error.message}`);
            }
        }
        
        const validTokens = tokensWithData.filter(t => t.liquidity > 20000);
        console.log(`✅ DexScreener: ${validTokens.length} tokens válidos (liquidez > $20k)`);
        return validTokens;
        
    } catch (error) {
        console.error(`❌ DexScreener error: ${error.message}`);
        return [];
    }
}

// ============================================
// FALLBACK BIRDEYE → DEXSCREENER
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
    // Verificar que el bot esté conectado antes de escanear
    if (!isPollingRunning) {
        console.log('⏳ Bot no conectado a Telegram, omitiendo escaneo...');
        return;
    }
    
    console.log("\n" + "=".repeat(50));
    console.log(`🔍 ESCANEO #${consecutiveErrors + 1} - ${new Date().toLocaleTimeString()}`);
    console.log("=".repeat(50));
    
    const { source, tokens } = await fetchTokensWithFallback();
    
    if (!source || tokens.length === 0) {
        console.error("❌ No se pudieron obtener tokens");
        return;
    }
    
    console.log(`📊 Fuente: ${source.toUpperCase()} | ${tokens.length} tokens a analizar`);
    
    let alertsSent = 0;
    let analyzedCount = 0;
    let securityPassCount = 0;
    
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
        
        analyzedCount++;
        console.log(`\n🔎 Analizando ${token.symbol} (${token.address.slice(0,8)}...)`);
        console.log(`   💧 Liquidez: $${Math.floor(token.liquidity).toLocaleString()}`);
        console.log(`   📊 Volumen: $${Math.floor(token.volume_24h_usd).toLocaleString()}`);
        console.log(`   📈 Cambio 1h: ${token.price_change_1h_percent > 0 ? '+' : ''}${token.price_change_1h_percent.toFixed(2)}%`);
        
        const security = await verifyTokenSecurity(token.address);
        
        if (!security.isSafe) {
            console.log(`❌ ${token.symbol} - RECHAZADO por seguridad`);
            continue;
        }
        
        securityPassCount++;
        
        seenTokens.add(token.address);
        setTimeout(() => seenTokens.delete(token.address), 3600000);
        
        const sourceNote = source === 'dexscreener' && apiStatus.birdeye.status !== 'active' 
            ? "\n⚠️ *Nota:* Datos vía DexScreener (Birdeye no disponible temporalmente)" 
            : "";
        
        const priceChangeEmoji = token.price_change_1h_percent > 0 ? "📈" : "📉";
        
        const messageText = `🔥 *HunterNode: Alerta de Alta Calidad*${sourceNote}

${priceChangeEmoji} *${token.symbol}* (${token.name})

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
• Market Cap: $${Math.floor(token.market_cap).toLocaleString()}

📑 *Contrato:*
\`${token.address}\`

🔗 *Enlaces:*
[📊 DexScreener](https://dexscreener.com/solana/${token.address}) | 
[🔍 RugCheck](https://rugcheck.xyz/tokens/${token.address}) | 
[🟢 Birdeye](https://birdeye.so/token/${token.address}?chain=solana)

---
⚠️ *NFA - Siempre haz tu propia investigación antes de invertir*`;
        
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
                            { text: "🟣 Jupiter (Comprar)", url: `https://jup.ag/swap/SOL-${token.address}` }
                        ]
                    ]
                }
            });
            
            alertsSent++;
            console.log(`\n✅✅✅ ALERTA ENVIADA: ${token.symbol} ✅✅✅`);
            
        } catch (error) {
            console.error(`❌ Error enviando alerta para ${token.symbol}: ${error.message}`);
            // Si hay error de conexión al enviar, marcar para reconectar
            if (error.message?.includes('polling') || error.message?.includes('ECONN')) {
                console.log('⚠️ Error de conexión detectado, reiniciando polling...');
                isPollingRunning = false;
                startBotWithRetry();
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log("\n" + "-".repeat(50));
    console.log(`📊 RESUMEN DEL ESCANEO:`);
    console.log(`   • Analizados: ${analyzedCount}`);
    console.log(`   • Pasaron seguridad: ${securityPassCount}`);
    console.log(`   • Alertas enviadas: ${alertsSent}`);
    console.log("-".repeat(50));
}

// ============================================
// COMANDOS DE TELEGRAM
// ============================================

bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `🤖 *HunterNode Activado - Modo Estricto*

🔐 *Filtros activos:*
• ✅ Liquidez mínima: $20,000
• ✅ Market Cap: $5k - $50M
• ✅ Volatilidad mínima: 5%
• ✅ Presión compradora: +20%
• ✅ Anti-honeypot
• ✅ Liquidez bloqueada (requerido)
• ✅ Freeze authority deshabilitada
• ✅ Mint authority deshabilitada
• ✅ Top 10 holders < 30%
• ✅ RugCheck con datos (requerido)

🔌 *Sistema de autoreconexión:* ✅ Activo
📡 *APIs:* Birdeye → DexScreener (fallback)

🔄 *Escaneo:* Cada 2 minutos

💡 *Comandos:*
/status - Ver estado del bot
/help - Ayuda

⚠️ *Recuerda:* Este bot solo alerta. Siempre haz tu propia investigación.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/status/, async (msg) => {
    const birdeyeStatus = apiStatus.birdeye.status === 'active' 
        ? '✅ Activo' 
        : apiStatus.birdeye.retryAfter 
            ? `⏳ Cooldown (${Math.ceil((apiStatus.birdeye.retryAfter - Date.now()) / 60000)} min restantes)`
            : '❌ Fallo';
    
    await bot.sendMessage(msg.chat.id,
        `📊 *Estado del HunterNode*

🔌 *APIs:*
• Birdeye: ${birdeyeStatus}
• DexScreener: ${apiStatus.dexscreener.status === 'active' ? '✅ Activo' : '⚠️ Problemas'}
• RugCheck: ✅ Activo

📡 *Conexión Telegram:*
• Polling: ${isPollingRunning ? '✅ Activo' : '❌ Desconectado'}
• Reintentos: ${reconnectAttempts}

📝 *Estadísticas:*
• Tokens en memoria: ${seenTokens.size}
• Errores consecutivos: ${consecutiveErrors}

🎯 *Modo:* Estricto (solo tokens 100% verificados)
📅 *Último escaneo:* ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `🆘 *Ayuda HunterNode*

*¿Qué hace este bot?*
Analiza tokens de Solana en tiempo real y alerta cuando encuentra oportunidades potenciales.

*¿Qué filtros usa?*
• Liquidez mínima: $20,000
• Market Cap: $5k - $50M
• Volatilidad: >5% en 1h
• Presión compradora: +20%
• Anti-honeypot
• Liquidez bloqueada
• Freeze/Mint authority deshabilitadas
• Holders top10 < 30%
• RugCheck con datos

*Sistema de autoreconexión:*
• Detecta caídas de internet automáticamente
• Reintenta conexión con backoff exponencial
• No requiere reinicio manual

*¿Cómo usar las alertas?*
1. Recibe la alerta en Telegram
2. Haz clic en los botones para ver el token
3. Analiza en DexScreener/RugCheck
4. Decide si comprar (NFA)

*Comandos:*
/start - Iniciar bot
/status - Ver estado
/help - Esta ayuda

⚠️ *ADVERTENCIA:* Los memecoins son de alto riesgo. Nunca inviertas más de lo que estás dispuesto a perder.`,
        { parse_mode: 'Markdown' }
    );
});

// ============================================
// MANEJO DE ERRORES GLOBALES
// ============================================

process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    if (isPollingRunning) {
        console.log('🔄 Reiniciando bot por error fatal...');
        isPollingRunning = false;
        startBotWithRetry();
    }
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Promesa rechazada:', error);
    // No reiniciamos automáticamente aquí porque puede ser solo una API fallando
});

// Manejar señales de terminación
process.on('SIGINT', () => {
    console.log('\n🛑 Recibida señal SIGINT. Cerrando bot...');
    if (scanInterval) clearInterval(scanInterval);
    bot.stopPolling().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Recibida señal SIGTERM. Cerrando bot...');
    if (scanInterval) clearInterval(scanInterval);
    bot.stopPolling().then(() => process.exit(0));
});

// ============================================
// INICIO DEL BOT
// ============================================

console.log("\n" + "=".repeat(50));
console.log("🚀 HUNTERNODE INICIALIZADO - MODO ESTRICTO");
console.log("=".repeat(50));
console.log("✅ Filtros activos:");
console.log("   • RugCheck (liquidez bloqueada, freeze/mint authority)");
console.log("   • Top 10 holders < 30%");
console.log("   • Anti-honeypot");
console.log("   • Liquidez mínima: $20,000");
console.log("   • Volatilidad mínima: 5%");
console.log("   • Tokens sin datos RugCheck: RECHAZADOS");
console.log("   • Errores RugCheck: RECHAZADOS");
console.log("✅ Sistema de autoreconexión: ACTIVADO");
console.log("✅ Sistema de fallback: Birdeye → DexScreener");
console.log("✅ Botones interactivos en Telegram");
console.log("=".repeat(50) + "\n");

// Iniciar el bot con sistema de autoreconexión
startBotWithRetry();

// Ejecutar escaneo inicial después de que el bot conecte
setTimeout(() => {
    if (isPollingRunning) {
        scanMemecoins();
    } else {
        console.log('⏳ Esperando conexión del bot para iniciar escaneo...');
        const waitForConnection = setInterval(() => {
            if (isPollingRunning) {
                clearInterval(waitForConnection);
                scanMemecoins();
            }
        }, 1000);
    }
}, 2000);

// Escanear cada 2 minutos (solo si el bot está conectado)
setInterval(() => {
    if (isPollingRunning) {
        scanMemecoins();
    } else {
        console.log('⏳ Bot desconectado, omitiendo escaneo programado...');
    }
}, 600000);