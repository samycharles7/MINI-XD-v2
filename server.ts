import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    makeCacheableSignalKeyStore,
    proto,
    downloadMediaMessage,
    jidDecode,
    getContentType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { createCanvas, loadImage } from 'canvas';
import { Sticker, createSticker, StickerTypes } from 'wa-sticker-formatter';
import { translate } from 'google-translate-api-x';
import yts from 'yt-search';
import QRCode from 'qrcode';

const logger = pino({ level: 'silent' });

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

// Settings management
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
let groupSettings: any = {};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        groupSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch (e) {
        console.error('Error loading settings:', e);
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings, null, 2));
}

function getUptime() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

function getLang() {
    return groupSettings['global']?.language || 'fr';
}

function t(fr: string, en: string) {
    return getLang() === 'fr' ? fr : en;
}

async function uploadToCatbox(buffer: Buffer) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename: 'image.png' });
        const res = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
            timeout: 30000 // 30 seconds timeout
        });
        
        if (typeof res.data === 'string' && res.data.startsWith('http')) {
            return res.data.trim();
        }
        
        console.error('Catbox upload returned invalid data:', res.data);
        return null;
    } catch (e: any) {
        console.error('Catbox upload failed:', e.message || e);
        return null;
    }
}

async function startServer() {
    const app = express();
    const PORT = 3000;

    app.use(express.json());

    // API for global settings
    app.get('/api/settings', (req, res) => {
        const lang = groupSettings['global']?.language || 'fr';
        res.json({ language: lang });
    });

    app.get('/api/status', (req, res) => {
        const connectedSessions = Array.from(sessions.values()).filter(s => s.user).length;
        res.json({ 
            status: connectedSessions > 0 ? 'online' : 'offline',
            sessions: connectedSessions,
            uptime: getUptime()
        });
    });

    app.post('/api/settings', (req, res) => {
        const { language } = req.body;
        if (language && ['fr', 'en'].includes(language)) {
            groupSettings['global'] = groupSettings['global'] || {};
            groupSettings['global'].language = language;
            saveSettings();
            res.json({ success: true, language });
        } else {
            res.status(400).json({ error: 'Invalid language' });
        }
    });

    // Store active pairing sessions
    const sessions = new Map();
    const connecting = new Set();
    const presenceIntervals = new Map();
    const heartbeatIntervals = new Map();
    const onReply: any[] = [];

    async function connectToWhatsApp(phoneNumber: string, res?: any) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        if (connecting.has(cleanPhone)) return;
        connecting.add(cleanPhone);

        const sessionId = `session_${cleanPhone}`;
        const sessionPath = path.join(process.cwd(), 'sessions', sessionId);

        try {
            // Clean up old session files if we are requesting a NEW pairing code
            if (res && fs.existsSync(sessionPath)) {
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } catch (e) {
                    console.error('Error cleaning session path:', e);
                }
            }

            // Close existing socket if any
            if (sessions.has(cleanPhone)) {
                try {
                    const oldSock = sessions.get(cleanPhone);
                    oldSock.ev.removeAllListeners('connection.update');
                    oldSock.ev.removeAllListeners('messages.upsert');
                    oldSock.ev.removeAllListeners('creds.update');
                    oldSock.end(undefined);
                    
                    // Clear presence interval
                    if (presenceIntervals.has(cleanPhone)) {
                        clearInterval(presenceIntervals.get(cleanPhone));
                        presenceIntervals.delete(cleanPhone);
                    }
                } catch (e) {}
                sessions.delete(cleanPhone);
            }

            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                // Use a standard browser string for better pairing code compatibility
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                generateHighQualityLinkPreview: true,
            });

            sessions.set(cleanPhone, sock);

            sock.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                } catch (err) {
                    console.error('Error saving credentials:', err);
                }
            });

            sock.ev.on('group-participants.update', async (anu) => {
                try {
                    const { id, participants, action } = anu;
                    const settings = groupSettings[id] || {};
                    
                    for (const participant of participants) {
                        const num = typeof participant === 'string' ? participant : (participant as any).id;
                        let ppUrl;
                        try {
                            ppUrl = await sock.profilePictureUrl(num, 'image');
                        } catch {
                            ppUrl = 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/j58t1den-1774102535417.png';
                        }

                        if (action === 'add' && settings.welcome) {
                            const welcomeMsg = settings.welcomeText ? settings.welcomeText.replace('@user', `@${num.split('@')[0]}`) : t(`*Bienvenue @${num.split('@')[0]} dans le groupe !* 🌸\n\n> 🧚 MINI-XD V2 🧚`, `*Welcome @${num.split('@')[0]} to the group!* 🌸\n\n> 🧚 MINI-XD V2 🧚`);
                            await sock.sendMessage(id, {
                                image: { url: ppUrl },
                                caption: welcomeMsg,
                                mentions: [num],
                                contextInfo: {
                                    forwardingScore: 999,
                                    isForwarded: true,
                                    forwardedNewsletterMessageInfo: {
                                        newsletterJid: '120363406104843715@newsletter',
                                        serverMessageId: 1,
                                        newsletterName: 'MINI XD TECH'
                                    }
                                }
                            });
                        } else if (action === 'remove' && settings.goodbye) {
                            const goodbyeMsg = settings.goodbyeText ? settings.goodbyeText.replace('@user', `@${num.split('@')[0]}`) : t(`*Au revoir @${num.split('@')[0]}...* 🌸\n\n> 🧚 MINI-XD V2 🧚`, `*Goodbye @${num.split('@')[0]}...* 🌸\n\n> 🧚 MINI-XD V2 🧚`);
                            await sock.sendMessage(id, {
                                image: { url: ppUrl },
                                caption: goodbyeMsg,
                                mentions: [num],
                                contextInfo: {
                                    forwardingScore: 999,
                                    isForwarded: true,
                                    forwardedNewsletterMessageInfo: {
                                        newsletterJid: '120363406104843715@newsletter',
                                        serverMessageId: 1,
                                        newsletterName: 'MINI XD TECH'
                                    }
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error('Error in group-participants.update:', err);
                }
            });

            sock.ev.on('connection.update', async (update) => {
                try {
                    const { connection, lastDisconnect, qr } = update;

                    if (qr && res && res.qr) {
                        try {
                            await res.qr(qr);
                        } catch (e) {
                            console.error('Error in QR callback:', e);
                        }
                    }
                    
                    if (connection === 'close') {
                        // Clear presence interval if it exists
                        if (presenceIntervals.has(cleanPhone)) {
                            clearInterval(presenceIntervals.get(cleanPhone));
                            presenceIntervals.delete(cleanPhone);
                        }
                        
                        // Clear heartbeat interval if it exists
                        if (heartbeatIntervals.has(cleanPhone)) {
                            clearInterval(heartbeatIntervals.get(cleanPhone));
                            heartbeatIntervals.delete(cleanPhone);
                        }

                        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                        let shouldReconnect = true;

                        if (statusCode === DisconnectReason.loggedOut) {
                            shouldReconnect = false;
                        } else if (statusCode === DisconnectReason.restartRequired) {
                            shouldReconnect = true;
                        } else if (statusCode === DisconnectReason.connectionLost) {
                            shouldReconnect = true;
                        } else if (statusCode === DisconnectReason.connectionReplaced) {
                            shouldReconnect = false; // Another session opened
                        } else if (statusCode === DisconnectReason.timedOut) {
                            shouldReconnect = true;
                        }

                        console.log(`Connection closed for ${cleanPhone}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                        
                        if (shouldReconnect) {
                            // Reconnect with a delay
                            const delay = 5000;
                            setTimeout(() => connectToWhatsApp(cleanPhone), delay);
                        } else {
                            console.log(`Session terminated for ${cleanPhone}. Cleaning up...`);
                            sessions.delete(cleanPhone);
                            if (fs.existsSync(sessionPath)) {
                                try {
                                    fs.rmSync(sessionPath, { recursive: true, force: true });
                                } catch (e) {}
                            }
                        }
                    } else if (connection === 'open') {
                        console.log('Connection opened for', cleanPhone);
                        
                        // Set presence to available immediately if enabled
                        const isAlwaysOnline = groupSettings['global']?.alwaysOnline !== false;
                        if (isAlwaysOnline) {
                            try {
                                await sock.sendPresenceUpdate('available');
                            } catch (e) {}
                        }

                        // Start presence update interval to keep session active
                        const interval = setInterval(async () => {
                            try {
                                const isAlwaysOnline = groupSettings['global']?.alwaysOnline !== false;
                                if (isAlwaysOnline) {
                                    await sock.sendPresenceUpdate('available');
                                }
                            } catch (e) {
                                console.error(`Presence update failed for ${cleanPhone}:`, e);
                            }
                        }, 20000); // Every 20 seconds
                        
                        presenceIntervals.set(cleanPhone, interval);

                        // Hourly heartbeat / auto-reconnect message
                        const heartbeatInterval = setInterval(async () => {
                            try {
                                const jid = sock.user?.id.split(':')[0] + '@s.whatsapp.net';
                                await sock.sendMessage(jid, { 
                                    text: getLang() === 'fr' 
                                        ? `*Ceci est un message de auto-reconnect (Heartbeat) 🌸*\n\n> 🧚 MINI-XD V2 est toujours actif ! 🧚`
                                        : `*This is an auto-reconnect message (Heartbeat) 🌸*\n\n> 🧚 MINI-XD V2 is still active! 🧚`
                                });
                            } catch (e) {
                                console.error('Heartbeat failed:', e);
                            }
                        }, 3600000); // Every 1 hour
                        
                        heartbeatIntervals.set(cleanPhone, heartbeatInterval);

                        const jid = sock.user?.id.split(':')[0] + '@s.whatsapp.net';
                        await sock.sendMessage(jid, { 
                            text: getLang() === 'fr' 
                                ? `*MINI-XD V2🌸 est maintenant connecté tapez .menu pour voir mes commandes disponibles 🚀😽*\n\n> 🧚 Fait avec amour par MINI-XD 🧚`
                                : `*MINI-XD V2🌸 is now connected type .menu to see my available commands 🚀😽*\n\n> 🧚 Made with love by MINI-XD 🧚`
                        });
                    }
                } catch (err) {
                    console.error('Error in connection.update:', err);
                }
            });

            sock.ev.on('messages.upsert', async (m) => {
                try {
                    if (m.type !== 'notify') return;
                    const msg = m.messages[0];
                    if (!msg.message) return;

                    const from = msg.key.remoteJid!;
                    
                    const isGroup = from.endsWith('@g.us');
                    const sender = isGroup ? msg.key.participant : from;
                    const isMe = msg.key.fromMe;
                    
                    // Initialize settings if not exists
                    if (!groupSettings[from]) {
                        groupSettings[from] = {
                            welcome: false,
                            goodbye: false,
                            antilink: false,
                            antispam: false,
                            autoreact: false
                        };
                    }
                    const settings = groupSettings[from];

                    // Robust body extraction using Baileys helper
                    let msgContent = msg.message;
                    if (msgContent.ephemeralMessage) msgContent = msgContent.ephemeralMessage.message!;
                    if (msgContent.viewOnceMessageV2) msgContent = msgContent.viewOnceMessageV2.message!;
                    if (msgContent.viewOnceMessageV2Extension) msgContent = msgContent.viewOnceMessageV2Extension.message!;
                    
                    const type = getContentType(msgContent);
                    const isForwardedFromChannel = (msgContent?.[type!] as any)?.contextInfo?.forwardedNewsletterMessageInfo;
                    let body = '';
                    if (type === 'conversation') body = msgContent.conversation!;
                    else if (type === 'extendedTextMessage') body = msgContent.extendedTextMessage?.text!;
                    else if (type === 'imageMessage') body = msgContent.imageMessage?.caption!;
                    else if (type === 'videoMessage') body = msgContent.videoMessage?.caption!;
                    else if (type === 'documentMessage') body = msgContent.documentMessage?.caption!;
                    else if (type === 'buttonsResponseMessage') body = msgContent.buttonsResponseMessage?.selectedButtonId!;
                    else if (type === 'listResponseMessage') body = msgContent.listResponseMessage?.singleSelectReply?.selectedRowId!;
                    else if (type === 'templateButtonReplyMessage') body = msgContent.templateButtonReplyMessage?.selectedId!;

                    // Handle replies for Midjourney
                    const contextInfo = (msgContent?.[type!] as any)?.contextInfo;
                    const repliedMsgId = contextInfo?.stanzaId;
                    if (repliedMsgId) {
                        const dataIndex = onReply.findIndex(r => r.commandName === "imagine" && r.messageID === repliedMsgId && r.author === sender);
                        if (dataIndex !== -1) {
                            const data = onReply[dataIndex];
                            const num = parseInt(body.trim());
                            if (!isNaN(num) && num >= 1 && num <= 4) {
                                const selectedBuffer = data.buffers[num - 1];
                                if (selectedBuffer) {
                                    try {
                                        await sock.sendMessage(from, {
                                            image: selectedBuffer,
                                            caption: t(`🎨 *Imagine - Image ${num}/4*\n\n📝 *Prompt:* ${data.prompt}`, `🎨 *Imagine - Image ${num}/4*\n\n📝 *Prompt:* ${data.prompt}`)
                                        }, { quoted: msg });
                                    } catch (e) {
                                        console.error("[IMAGINE REPLY] Error:", e);
                                    }
                                }
                            }
                        }
                    }

                    // Chatbot logic for private messages
                    if (!isGroup && !isMe && !body.startsWith('.') && groupSettings['global']?.chatbot) {
                        try {
                            // Indicate typing
                            await sock.sendPresenceUpdate('composing', from);
                            
                            const prompt = t(
                                `Réponds comme un humain ivoirien cool et amical à ce message : "${body}". Garde un style court et naturel.`,
                                `Respond like a cool and friendly human to this message: "${body}". Keep it short and natural.`
                            );
                            
                            const res = await axios.get(`https://arychauhann.onrender.com/api/gemini-proxy2?prompt=${encodeURIComponent(prompt)}`);
                            
                            if (res.data?.answer) {
                                await sock.sendMessage(from, { text: res.data.answer }, { quoted: msg });
                            }
                            
                            await sock.sendPresenceUpdate('paused', from);
                        } catch (e) {
                            console.error('Chatbot auto-reply failed:', e);
                        }
                    }

                    const command = body.toLowerCase().trim();
                    const args = body.split(' ').slice(1);
                    const q = args.join(' ');

                    const isOwner = isMe || sender?.split('@')[0] === '2250574082069';
                    const groupMetadata = isGroup ? await sock.groupMetadata(from) : null;
                    const participants = groupMetadata ? groupMetadata.participants : [];
                    const admins = participants.filter(p => p.admin).map(p => p.id);
                    const isAdmin = admins.includes(sender!) || isOwner;

                    console.log(`[MSG] From: ${from} | Self: ${isMe} | Type: ${type} | Body: ${body}`);

                    // Check if bot is in private mode
                    const isPublic = groupSettings['global']?.public !== false;
                    if (!isPublic && !isOwner && body.startsWith('.')) return;

                    // If it's from me and NOT a command, skip to avoid loops
                    // BUT allow .vv and .status to work on self messages if they are commands
                    if (isMe && !body.startsWith('.')) return;

                    // Helper for styled responses
                    const sendStyled = async (text: string, mentions?: string[], isForwarded: boolean = false) => {
                        const messageOptions: any = { 
                            text: text,
                            mentions: mentions || []
                        };

                        if (isForwarded) {
                            messageOptions.contextInfo = {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363406104843715@newsletter',
                                    serverMessageId: 1,
                                    newsletterName: 'MINI XD TECH'
                                }
                            };
                        }

                        return sock.sendMessage(from, messageOptions, { quoted: msg });
                    };

                    // Helper for simple status responses
                    const sendSimple = async (text: string) => {
                        return sock.sendMessage(from, { text: `*🍬🌸 ${text}*` }, { quoted: msg });
                    };

                    // Antilink logic
                    if (isGroup && settings.antilink && (body.match(/chat.whatsapp.com|http|https/gi) || isForwardedFromChannel)) {
                        try {
                            const metadata = await sock.groupMetadata(from);
                            const isAdmin = metadata.participants.find(p => p.id === sender)?.admin;
                            if (!isAdmin) {
                                await sock.sendMessage(from, { delete: msg.key });
                                await sock.sendMessage(from, { text: t(`*Lien ou contenu de chaîne détecté ! @${sender?.split('@')[0]} a été averti.* ⚠️`, `*Link or channel content detected! @${sender?.split('@')[0]} has been warned.* ⚠️`), mentions: [sender!] });
                                return;
                            }
                        } catch (e) {
                            console.error('Error in antilink:', e);
                        }
                    }

                    // Antispam logic (simple rate limiting)
                    if (isGroup && settings.antispam) {
                        // This is a placeholder for more complex logic
                    }

                    // Autoreact logic
                    if (settings.autoreact) {
                        const emojis = ['🌸', '👑', '✨', '🎀', '🧚', '🚀', '😽', '🔥', '💎'];
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await sock.sendMessage(from, { react: { text: randomEmoji, key: msg.key } });
                    }

                    // Status reaction logic
                    if (from === 'status@broadcast') {
                        // Mark as seen
                        try {
                            await sock.readMessages([msg.key]);
                        } catch (e) {
                            console.error('Error marking status as seen:', e);
                        }

                        if (groupSettings['global']?.statusReact) {
                            const emoji = groupSettings['global']?.statusReactEmoji || '❤️';
                            await sock.sendMessage(from, { react: { text: emoji, key: msg.key } }, { statusJidList: [msg.key.participant!] });
                        }
                    }

                if (command === '.menu' || command === 'menu') {
                    await sock.sendMessage(from!, { react: { text: '🌸', key: msg.key } });

                    const menuText = `╭─── 🍬 *${t('MENU MINI XD', 'MINI XD MENU')}* 🍬 ───╮
│
│ ✨ *${t('Prσρrıσ', 'Oωnᧉr')}* » *Samy Charles*
│ 🎀 *${t('Uρtıɱᧉ', 'Uρtıɱᧉ')}* » *${getUptime()}*
│ 🌸 *${t('Stαtus', 'Stαtus')}* » *${t('Actif', 'Active')}*
│ 🎀 *${t('Dαtᧉ', 'Dαtᧉ')}* » *${new Date().toLocaleDateString()}*
│
╰───────────────────╯

╭────── 🍬 『AI』
│     ⏣ .imagine
╰──────────────────╯

╭────── 🍬 『${t('RÉGLAGES', 'SETTINGS')}』
│     ⏣ .owner
│     ⏣ .autoreact
│     ⏣ .statutreact
│     ⏣ .public
│     ⏣ .private
│     ⏣ .alwaysonline
│     ⏣ .reconnect
│     ⏣ .addstatus
│     ⏣ .chatbot
│     ⏣ .lang
│     ⏣ .pair
│     ⏣ .pairqr
│     ⏣ .tuto
╰──────────────────╯

╭────── 🍬 『${t('GROUPE', 'GROUP')}』
│     ⏣ .welcome
│     ⏣ .goodbye
│     ⏣ .antilink
│     ⏣ .antispam
│     ⏣ .add
│     ⏣ .kick
│     ⏣ .promote
│     ⏣ .demote
│     ⏣ .setname
│     ⏣ .setdesc
│     ⏣ .setpp
│     ⏣ .tagall
│     ⏣ .hidetag
│     ⏣ .mute
│     ⏣ .unmute
│     ⏣ .ephemeral
│     ⏣ .admins
│     ⏣ .invite
│     ⏣ .revoke
│     ⏣ .warn
│     ⏣ .resetwarn
│     ⏣ .kickme
│     ⏣ .leave
│     ⏣ .tagadmin
│     ⏣ .groupinfo
│     ⏣ .listgc
│     ⏣ .clear
╰──────────────────╯

╭────── 🍬 『${t('TÉLÉCHARGEMENT', 'DOWNLOAD')}』
│     ⏣ .play
│     ⏣ .ytmp4
│     ⏣ .tiktok
│     ⏣ .fbdown
│     ⏣ .igstalk
╰──────────────────╯

╭────── 🍬 『${t('RECHERCHE', 'SEARCH')}』
│     ⏣ .google
│     ⏣ .wiki
│     ⏣ .lyrics
│     ⏣ .github
│     ⏣ .npm
│     ⏣ .weather
╰──────────────────╯

╭────── 🍬 『${t('OUTILS', 'TOOLS')}』
│     ⏣ .s / .sticker
│     ⏣ .setpack
│     ⏣ .setauthor
│     ⏣ .toimg
│     ⏣ .translate
│     ⏣ .vv
│     ⏣ .status
│     ⏣ .calc
│     ⏣ .ssweb
│     ⏣ .qr
│     ⏣ .shortlink
│     ⏣ .remini / .hd
│     ⏣ .ai
│     ⏣ .alive
│     ⏣ .botstart
│     ⏣ .ocr
│     ⏣ .define
│     ⏣ .tinyurl
│     ⏣ .bitly
╰──────────────────╯

╭────── 🍬 『${t('MANGA & ANIME', 'MANGA & ANIME')}』
│     ⏣ .manga
│     ⏣ .anime
│     ⏣ .character
│     ⏣ .topmanga
│     ⏣ .topanime
│     ⏣ .upcoming
│     ⏣ .airing
│     ⏣ .recommend
│     ⏣ .mangainfo
│     ⏣ .animeinfo
╰──────────────────╯

╭────── 🍬 『${t('FUN', 'FUN')}』
│     ⏣ .quote
│     ⏣ .fact
│     ⏣ .joke
│     ⏣ .couple
│     ⏣ .ship
│     ⏣ .love
│     ⏣ .heart
╰──────────────────╯

╭────── 🍬 『${t('INFOS BOT', 'BOT INFO')}』
│     ⏣ .botstatus
│     ⏣ .uptime
│     ⏣ .ping
│     ⏣ .runtime
╰──────────────────╯

𝚋𝚢 𝚂𝚊𝚖𝚢 𝙲𝚑𝚊𝚛𝚕𝚎𝚜 ©𝟸𝟶𝟸𝟻-𝟸𝟶𝟸𝟼🫟`;

                    await sock.sendMessage(from!, { 
                        image: { url: 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/j58t1den-1774102535417.png' },
                        caption: menuText,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363406104843715@newsletter',
                                serverMessageId: 1,
                                newsletterName: 'MINI XD TECH'
                            }
                        }
                    }, { quoted: msg });
                }

                if (command === '.owner') {
                    await sock.sendMessage(from!, { 
                        contacts: {
                            displayName: 'Samy Charles',
                            contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Samy Charles\nTEL;type=CELL;type=VOICE;waid=2250500000000:+225 05 00 00 00 00\nEND:VCARD` }]
                        }
                    }, { quoted: msg });
                }

                if (command === '.love') {
                    const loveMsgs = [
                        t("Tu es la personne la plus spéciale au monde ! 💖", "You are the most special person in the world! 💖"),
                        t("Mon petit cœur bat pour toi... 🌸✨", "My little heart beats for you... 🌸✨"),
                        t("Tu es un rayon de soleil dans ma journée ! ☀️🎀", "You are a ray of sunshine in my day! ☀️🎀"),
                        t("N'oublie jamais à quel point tu es incroyable. 🧚💎", "Never forget how amazing you are. 🧚💎")
                    ];
                    const randomLove = loveMsgs[Math.floor(Math.random() * loveMsgs.length)];
                    await sendStyled(randomLove);
                }

                if (command === '.heart') {
                    await sock.sendMessage(from!, { react: { text: '💖', key: msg.key } });
                    await sendSimple(t("Plein d'amour pour toi ! ✨🌸", "Lots of love for you! ✨🌸"));
                }

                if (command === '.groupinfo') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
                    const info = `${t('📋 *INFO DU GROUPE*', '📋 *GROUP INFO*')}

✨ *₊·( ✰ ) ${t('Nσɱ', 'Nαɱᧉ')}* » *${metadata.subject}*
🎀 *₊·( ✰ ) ID* » *${metadata.id}*
🌸 *₊·( ✰ ) ${t('Mᧉɱbrᧉs', 'Mᧉɱbᧉrs')}* » *${metadata.participants.length}*
🧚 *₊·( ✰ ) Adɱıns* » *${admins.length}*
✨ *₊·( ✰ ) ${t('Créé lᧉ', 'Crᧉαtᧉd σn')}* » *${new Date(metadata.creation! * 1000).toLocaleDateString()}*
🌸 *₊·( ✰ ) Dᧉsc* » *${metadata.desc || t('Aucune', 'None')}*`;
                    await sendStyled(info);
                }

                if (command === '.statutreact') {
                    if (!isAdmin && !isOwner) return await sendSimple(t('❌ Uniquement pour les admins !', '❌ Only for admins!'));
                    if (args[0] === 'off') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].statusReact = false;
                        saveSettings();
                        return await sendSimple(t('Réaction aux statuts désactivée.', 'Status reaction disabled.'));
                    }
                    const emoji = args[0] || '❤️';
                    groupSettings['global'] = groupSettings['global'] || {};
                    groupSettings['global'].statusReact = true;
                    groupSettings['global'].statusReactEmoji = emoji;
                    saveSettings();
                    await sendSimple(t(`Réaction aux statuts activée avec l'emoji : ${emoji}`, `Status reaction enabled with emoji: ${emoji}`));
                }

                if (command === '.settings' || command === 'settings') {
                    await sendStyled(`${t('⚙️ *RÉGLAGES*', '⚙️ *SETTINGS*')}\n\n🌸 .owner\n🌸 .autoreact\n🌸 .statutreact\n🌸 .lang [fr/en]\n🌸 .public\n🌸 .private\n🌸 .addstatus\n🌸 .chatbot`, [], true);
                }

                if (command.startsWith('.lang ')) {
                    if (!isOwner) return await sendSimple(t('❌ Uniquement pour le propriétaire !', '❌ Only for the owner!'));
                    const lang = command.split(' ')[1].toLowerCase();
                    if (lang === 'fr' || lang === 'en') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].language = lang;
                        saveSettings();
                        await sendSimple(t('✅ Langue changée en Français !', '✅ Language changed to English!'));
                    } else {
                        await sendSimple(t('❌ Langue invalide (fr/en) !', '❌ Invalid language (fr/en)!'));
                    }
                }

                if (command === '.pair' || command.startsWith('.pair ')) {
                    const phoneNumber = q.replace(/[^0-9]/g, '');
                    if (!phoneNumber) return await sendSimple(t('❌ Veuillez fournir un numéro de téléphone (ex: .pair 225...)', '❌ Please provide a phone number (ex: .pair 225...)'));
                    
                    await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
                    
                    const mockRes = {
                        json: async (data: any) => {
                            if (data.code) {
                                await sendStyled(`✨ *MINI XD PAIRING* ✨\n\n${t('Voici votre code de couplage :', 'Here is your pairing code:')}\n\n*${data.code}*`);
                            } else if (data.message) {
                                await sendStyled(data.message);
                            }
                            mockRes.headersSent = true;
                        },
                        status: (code: number) => {
                            return {
                                json: async (data: any) => {
                                    await sendStyled(`❌ Error ${code}: ${data.error}`);
                                    mockRes.headersSent = true;
                                }
                            };
                        },
                        headersSent: false
                    };
                    
                    try {
                        await connectToWhatsApp(phoneNumber, mockRes);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors de la génération du code.', '❌ Error generating the code.'));
                    }
                }

                if (command === '.pairqr' || command.startsWith('.pairqr ')) {
                    const phoneNumber = q.replace(/[^0-9]/g, '');
                    if (!phoneNumber) return await sendSimple(t('❌ Veuillez fournir un numéro de téléphone (ex: .pairqr 225...)', '❌ Please provide a phone number (ex: .pairqr 225...)'));
                    
                    await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
                    await sendSimple(t('⏳ Génération du QR Code...', '⏳ Generating QR Code...'));

                    const mockRes: any = {
                        qr: async (qr: string) => {
                            if (mockRes.headersSent) return;
                            mockRes.headersSent = true;
                            
                            try {
                                const qrBuffer = await QRCode.toBuffer(qr, { scale: 8 });
                                await sock.sendMessage(from!, { 
                                    image: qrBuffer, 
                                    caption: `✨ *MINI XD QR PAIRING* ✨\n\n${t('Scannez ce QR code pour vous connecter.', 'Scan this QR code to connect.')}`
                                }, { quoted: msg });
                            } catch (err) {
                                console.error('QR code generation failed:', err);
                                await sendSimple(t('❌ Erreur lors de la génération du QR Code.', '❌ Error generating the QR Code.'));
                            }
                        },
                        headersSent: false
                    };
                    
                    try {
                        await connectToWhatsApp(phoneNumber, mockRes);
                        // Timeout if no QR is received within 60 seconds
                        setTimeout(() => {
                            if (!mockRes.headersSent) {
                                mockRes.headersSent = true;
                                sendSimple(t('❌ Délai d\'attente du QR Code dépassé.', '❌ QR Code timeout.')).catch(() => {});
                            }
                        }, 60000);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors de la génération du QR Code.', '❌ Error generating the QR Code.'));
                    }
                }

                if (command === '.owner' || command === 'owner') {
                    await sendStyled(`${t('👑 *INFOS PROPRIO*', '👑 *OWNER INFO*')}

✨ *₊·( ✰ ) ${t('Nσɱ', 'Nαɱᧉ')}* » *Samy Charles*
🎀 *₊·( ✰ ) ${t('Âgᧉ', 'Agᧉ')}* » *15 ans*
🧚 *₊·( ✰ ) ${t('Nuɱ', 'Nuɱ')}* » *+2250574082069*
🌸 *₊·( ✰ ) ${t('Pαys', 'Cσuntry')}* » *Ivoirien 🇨🇮*
✨ *₊·( ✰ ) ${t('Vıllᧉ', 'Cıty')}* » *Abidjan*
🎀 *₊·( ✰ ) ${t('Rôlᧉ', 'Rσlᧉ')}* » *Développeur MINI-XD*
🧚 *₊·( ✰ ) ${t('Pαssıσn', 'Pαssıσn')}* » *Codage & Musique*
🌸 *₊·( ✰ ) ${t('Stαtus', 'Stαtus')}* » *Passionné de Bot*`, [], true);
                }

                if (command === '.public') {
                    if (!isOwner) return await sendSimple(t('❌ Uniquement pour le propriétaire !', '❌ Only for the owner!'));
                    groupSettings['global'] = groupSettings['global'] || {};
                    groupSettings['global'].public = true;
                    saveSettings();
                    await sendSimple(t('Bot en mode PUBLIC ! Tout le monde peut l\'utiliser.', 'Bot in PUBLIC mode! Everyone can use it.'));
                }

                if (command === '.private') {
                    if (!isOwner) return await sendSimple(t('❌ Uniquement pour le propriétaire !', '❌ Only for the owner!'));
                    groupSettings['global'] = groupSettings['global'] || {};
                    groupSettings['global'].public = false;
                    saveSettings();
                    await sendSimple(t('Bot en mode PRIVÉ ! Seul le propriétaire peut l\'utiliser.', 'Bot in PRIVATE mode! Only the owner can use it.'));
                }

                if (command === '.alwaysonline' || command.startsWith('.alwaysonline ')) {
                    if (!isOwner) return await sendSimple(t("Désolé, seul mon propriétaire peut utiliser cette commande.", "Sorry, only my owner can use this command."));
                    if (!q) return await sendSimple(t("Utilisation : .alwaysonline on/off", "Usage: .alwaysonline on/off"));
                    
                    const mode = q.toLowerCase();
                    if (mode === 'on') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].alwaysOnline = true;
                        saveSettings();
                        await sock.sendPresenceUpdate('available');
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        return await sendStyled(t("Mode Toujours en Ligne activé ! Le bot apparaîtra désormais comme en ligne 24/7.", "Always Online mode activated! The bot will now appear online 24/7."));
                    } else if (mode === 'off') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].alwaysOnline = false;
                        saveSettings();
                        await sock.sendPresenceUpdate('unavailable');
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        return await sendStyled(t("Mode Toujours en Ligne désactivé.", "Always Online mode deactivated."));
                    } else {
                        return await sendSimple(t("Utilisation : .alwaysonline on/off", "Usage: .alwaysonline on/off"));
                    }
                }

                if (command === '.reconnect') {
                    if (!isOwner) return await sendSimple(t("Désolé, seul mon propriétaire peut utiliser cette commande.", "Sorry, only my owner can use this command."));
                    await sendSimple(t("Reconnexion en cours...", "Reconnecting..."));
                    sock.end(undefined);
                    return;
                }

                if (command === '.listgc') {
                    if (!isOwner) return await sendSimple(t('❌ Uniquement pour le propriétaire !', '❌ Only for the owner!'));
                    const groups = await sock.groupFetchAllParticipating();
                    let text = `📋 *${t('LISTE DES GROUPES', 'GROUP LIST')}*\n\n`;
                    Object.values(groups).forEach(g => {
                        text += `✨ *${g.subject}*\nID: ${g.id}\n\n`;
                    });
                    await sendStyled(text);
                }

                if (command === '.addstatus' || command === 'addstatus') {
                    if (!isOwner) return await sendSimple(t('❌ Seul le propriétaire peut utiliser cette commande.', '❌ Only the owner can use this command.'));
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return await sendSimple(t('❌ Veuillez répondre à une image, vidéo ou audio.', '❌ Please reply to an image, video, or audio.'));

                    const mediaType = Object.keys(quoted)[0];
                    if (['imageMessage', 'videoMessage', 'audioMessage'].includes(mediaType)) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '⏳', key: msg.key } });
                            const buffer = await downloadMediaMessage({ message: quoted } as any, 'buffer', {});
                            
                            let messageOptions: any = {};
                            if (mediaType === 'imageMessage') {
                                messageOptions = { image: buffer, caption: quoted.imageMessage?.caption || '' };
                            } else if (mediaType === 'videoMessage') {
                                messageOptions = { video: buffer, caption: quoted.videoMessage?.caption || '' };
                            } else if (mediaType === 'audioMessage') {
                                messageOptions = { audio: buffer, ptt: true };
                            }

                            await sock.sendMessage('status@broadcast', messageOptions);
                            
                            await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                            await sendStyled(t('✅ Contenu ajouté à votre statut avec succès !', '✅ Content added to your status successfully!'));
                        } catch (e) {
                            console.error('Error adding to status:', e);
                            await sendSimple(t('❌ Une erreur est survenue lors de l\'ajout au statut.', '❌ An error occurred while adding to status.'));
                        }
                    } else {
                        await sendSimple(t('❌ Type de média non supporté. Veuillez répondre à une image, vidéo ou audio.', '❌ Unsupported media type. Please reply to an image, video, or audio.'));
                    }
                }

                if (command.startsWith('.chatbot ')) {
                    if (!isOwner) return await sendSimple(t('❌ Uniquement pour le propriétaire !', '❌ Only for the owner!'));
                    const mode = command.split(' ')[1];
                    if (mode === 'on') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].chatbot = true;
                        saveSettings();
                        await sendSimple(t('Chatbot activé ! Le bot répondra aux messages privés.', 'Chatbot enabled! The bot will respond to private messages.'));
                    } else if (mode === 'off') {
                        groupSettings['global'] = groupSettings['global'] || {};
                        groupSettings['global'].chatbot = false;
                        saveSettings();
                        await sendSimple(t('Chatbot désactivé !', 'Chatbot disabled!'));
                    } else {
                        await sendSimple(t('💡 Utilisation : .chatbot on/off', '💡 Usage: .chatbot on/off'));
                    }
                }

                if (command === '.ai' || command.startsWith('.ai ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez poser une question.', '❌ Please ask a question.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '🤖', key: msg.key } });
                        const res = await axios.get(`https://arychauhann.onrender.com/api/gemini-proxy2?prompt=${encodeURIComponent(q)}`);
                        if (res.data?.answer) {
                            await sendStyled(`🤖 *AI ASSISTANT*\n\n${res.data.answer}`);
                        } else {
                            await sendSimple(t('❌ Impossible d\'obtenir une réponse de l\'IA.', '❌ Unable to get a response from AI.'));
                        }
                    } catch (e) {
                        console.error('AI command failed:', e);
                        await sendSimple(t('❌ Erreur lors de la connexion à l\'IA.', '❌ Error connecting to AI.'));
                    }
                }

                if (command === '.alive' || command === 'alive') {
                    const aliveText = `*🍬🌸 MINI XD ALIVE 🌸🍬*

✨ *${t('Nσɱ du Bσt', 'Bσt Nαɱᧉ')}* : *MINI XD*
🎀 *${t('Vᧉrsıσn', 'Vᧉrsıσn')}* : *2.0.0*
🌸 *${t('Prσρrıσ', 'Oωnᧉr')}* : *Samy Charles*
🚀 *${t('Uρtıɱᧉ', 'Uρtıɱᧉ')}* : *${getUptime()}*
💎 *${t('Stαtus', 'Stαtus')}* : *${t('En ligne !', 'Online !')}*`;

                    const buttons = [
                        { buttonId: '.botstart', buttonText: { displayText: '🍿 Botstart' }, type: 1 }
                    ];

                    const buttonMessage = {
                        text: aliveText,
                        footer: t('Cliquez sur le bouton ci-dessous pour tester la puissance !', 'Click the button below to test the power!'),
                        buttons: buttons,
                        headerType: 1,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363406104843715@newsletter',
                                serverMessageId: 1,
                                newsletterName: 'MINI XD TECH'
                            }
                        }
                    };

                    await sock.sendMessage(from!, buttonMessage, { quoted: msg });
                }

                if (command === '.botstart' || command === 'botstart') {
                    await sock.sendMessage(from!, { react: { text: '🍿', key: msg.key } });
                    const startInfo = `🚀 *${t('PERFORMANCE DU BOT', 'BOT PERFORMANCE')}* 🚀

✨ *₊·( ✰ ) ${t('Vıtᧉssᧉ', 'Sρᧉᧉd')}* » *${t('Rapide comme l\'éclair', 'Fast as lightning')}*
🎀 *₊·( ✰ ) Rαɱ* » *${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB / ${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB*
🌸 *₊·( ✰ ) Cρu* » *Stable*
🧚 *₊·( ✰ ) Uρtıɱᧉ* » *${getUptime()}*

*${t('MINI XD est prêt à vous servir !', 'MINI XD is ready to serve you!')}* 💎`;
                    await sendStyled(startInfo);
                }

                if (command.startsWith('.autoreact ')) {
                    const mode = command.split(' ')[1];
                    if (mode === 'on') {
                        settings.autoreact = true;
                        groupSettings[from!] = settings;
                        saveSettings();
                        await sendSimple(t('Autoreact activé !', 'Autoreact enabled!'));
                    } else if (mode === 'off') {
                        settings.autoreact = false;
                        groupSettings[from!] = settings;
                        saveSettings();
                        await sendSimple(t('Autoreact désactivé !', 'Autoreact disabled!'));
                    } else {
                        await sendSimple(t('💡 Utilisation : .autoreact on/off', '💡 Usage: .autoreact on/off'));
                    }
                }

                // Group Module
                if (command === '.group' || command === 'group') {
                    await sendStyled(`${t('👥 *COMMANDES DE GROUPE*', '👥 *GROUP COMMANDS*')}\n\n🌸 .welcome\n🌸 .goodbye\n🌸 .antilink\n🌸 .promote\n🌸 .demote\n🌸 .promoteall\n🌸 .demoteall\n🌸 .kick\n🌸 .kickall\n🌸 .mute / .unmute\n🌸 .link\n🌸 .tagall\n🌸 .hidetag\n🌸 .gcpp\n🌸 .setname\n🌸 .setpp\n🌸 .setdesc\n🌸 .opentime\n🌸 .closetime\n🌸 .pin / .unpin`);
                }

                if (command.startsWith('.setname ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const q = command.slice(9).trim();
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un nouveau nom.', '❌ Please provide a new name.'));
                    try {
                        await sock.groupUpdateSubject(from!, q);
                        await sendStyled(t('✅ Nom du groupe mis à jour !', '✅ Group name updated!'));
                    } catch (e) {
                        await sendSimple(t('❌ Erreur : Je ne suis probablement pas admin !', '❌ Error: I am probably not an admin!'));
                    }
                }

                if (command.startsWith('.welcome ')) {
                    const mode = command.split(' ')[1];
                    settings.welcome = mode === 'on';
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sendSimple(t(`Welcome a été ${mode === 'on' ? 'activé' : 'désactivé'} !`, `Welcome has been ${mode === 'on' ? 'enabled' : 'disabled'}!`));
                }

                if (command.startsWith('.goodbye ')) {
                    const mode = command.split(' ')[1];
                    settings.goodbye = mode === 'on';
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sendSimple(t(`Goodbye a été ${mode === 'on' ? 'activé' : 'désactivé'} !`, `Goodbye has been ${mode === 'on' ? 'enabled' : 'disabled'}!`));
                }

                if (command.startsWith('.antilink ')) {
                    const mode = command.split(' ')[1];
                    settings.antilink = mode === 'on';
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sendSimple(t(`Antilink a été ${mode === 'on' ? 'activé' : 'désactivé'} !`, `Antilink has been ${mode === 'on' ? 'enabled' : 'disabled'}!`));
                }

                if (command.startsWith('.antispam ')) {
                    const mode = command.split(' ')[1];
                    settings.antispam = mode === 'on';
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sendSimple(t(`Antispam a été ${mode === 'on' ? 'activé' : 'désactivé'} !`, `Antispam has been ${mode === 'on' ? 'enabled' : 'disabled'}!`));
                }

                if (command.startsWith('.promote')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const users = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                        users.push(msg.message.extendedTextMessage.contextInfo.participant!);
                    }
                    try {
                        for (const user of users) {
                            await sock.groupParticipantsUpdate(from!, [user], 'promote');
                        }
                        await sock.sendMessage(from!, { text: t('*Utilisateurs promus !* ✅', '*Users promoted!* ✅') }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from!, { text: t('*Erreur : Je ne suis probablement pas admin !* ❌', '*Error: I am probably not an admin!* ❌') });
                    }
                }

                if (command.startsWith('.demote')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const users = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                        users.push(msg.message.extendedTextMessage.contextInfo.participant!);
                    }
                    try {
                        for (const user of users) {
                            await sock.groupParticipantsUpdate(from!, [user], 'demote');
                        }
                        await sock.sendMessage(from!, { text: t('*Utilisateurs rétrogradés !* ❌', '*Users demoted!* ❌') }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from!, { text: t('*Erreur : Je ne suis probablement pas admin !* ❌', '*Error: I am probably not an admin!* ❌') });
                    }
                }

                if (command === '.promoteall') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    try {
                        const metadata = await sock.groupMetadata(from!);
                        const participants = metadata.participants.map(p => p.id);
                        await sock.groupParticipantsUpdate(from!, participants, 'promote');
                        await sock.sendMessage(from!, { text: t('*Tout le monde est admin !* 👑', '*Everyone is admin!* 👑') }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from!, { text: t('*Erreur : Impossible de promouvoir tout le monde !* ❌', '*Error: Unable to promote everyone!* ❌') }, { quoted: msg });
                    }
                }

                if (command === '.demoteall') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    try {
                        const metadata = await sock.groupMetadata(from!);
                        const participants = metadata.participants.map(p => p.id);
                        await sock.groupParticipantsUpdate(from!, participants, 'demote');
                        await sock.sendMessage(from!, { text: t('*Tout le monde est membre !* 👥', '*Everyone is a member!* 👥') }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from!, { text: t('*Erreur : Impossible de rétrograder tout le monde !* ❌', '*Error: Unable to demote everyone!* ❌') }, { quoted: msg });
                    }
                }

                if (command.startsWith('.kick')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const users = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                        users.push(msg.message.extendedTextMessage.contextInfo.participant!);
                    }
                    try {
                        for (const user of users) {
                            await sock.groupParticipantsUpdate(from!, [user], 'remove');
                        }
                        await sock.sendMessage(from!, { text: t('*Utilisateurs expulsés !* 🚪', '*Users kicked!* 🚪') }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(from!, { text: t('*Erreur : Je ne suis probablement pas admin !* ❌', '*Error: I am probably not an admin!* ❌') });
                    }
                }

                if (command === '.acceptall') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    if (!isAdmin && !isOwner) return await sendSimple(t('❌ Uniquement pour les admins !', '❌ Only for admins!'));
                    try {
                        const requests = await sock.groupRequestParticipantsList(from!);
                        if (!requests || requests.length === 0) return await sendSimple(t('❌ Aucune demande en attente.', '❌ No pending requests.'));
                        
                        for (const req of requests) {
                            await sock.groupRequestParticipantsUpdate(from!, [req.jid], 'approve');
                        }
                        await sock.sendMessage(from!, { text: t(`*${requests.length} demande(s) acceptée(s) !* ✅`, `*${requests.length} request(s) accepted!* ✅`) }, { quoted: msg });
                    } catch (e) {
                        console.error('Error in acceptall:', e);
                        await sendSimple(t('❌ Erreur : Je ne suis probablement pas admin ou une erreur est survenue.', '❌ Error: I am probably not an admin or an error occurred.'));
                    }
                }

                if (command === '.pin') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quoted) {
                        await sock.sendMessage(from!, { pin: msg.message?.extendedTextMessage?.contextInfo?.stanzaId! } as any, { quoted: msg });
                        await sock.sendMessage(from!, { text: t('*Message épinglé !* 📌', '*Message pinned!* 📌') }, { quoted: msg });
                    }
                }

                if (command === '.unpin') {
                    await sock.sendMessage(from!, { unpin: true } as any, { quoted: msg });
                    await sock.sendMessage(from!, { text: t('*Message désépinglé !* 📍', '*Message unpinned!* 📍') }, { quoted: msg });
                }

                if (command === '.mute') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sock.groupSettingUpdate(from!, 'announcement');
                    await sock.sendMessage(from!, { text: t('*Groupe fermé !* 🔒', '*Group closed!* 🔒') }, { quoted: msg });
                }

                if (command === '.unmute') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sock.groupSettingUpdate(from!, 'not_announcement');
                    await sock.sendMessage(from!, { text: t('*Groupe ouvert !* 🔓', '*Group opened!* 🔓') }, { quoted: msg });
                }

                if (command === '.link') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const code = await sock.groupInviteCode(from!);
                    await sock.sendMessage(from!, { text: `https://chat.whatsapp.com/${code}` }, { quoted: msg });
                }

                if (command === '.tagall') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const participants = metadata.participants;
                    let text = `*🌸 ─── 🍬 TAG ALL 🍬 ─── 🌸*\n\n`;
                    participants.forEach(p => {
                        text += `✨ @${p.id.split('@')[0]}\n`;
                    });
                    text += `\n> *🧚 MINI-XD V2 🧚*`;
                    
                    let ppUrl;
                    try {
                        ppUrl = await sock.profilePictureUrl(from!, 'image');
                    } catch {
                        try {
                            ppUrl = await sock.profilePictureUrl(sock.user?.id!, 'image');
                        } catch {
                            ppUrl = 'https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/j58t1den-1774102535417.png';
                        }
                    }

                    await sock.sendMessage(from!, { 
                        image: { url: ppUrl },
                        caption: text, 
                        mentions: participants.map(p => p.id),
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363406104843715@newsletter',
                                serverMessageId: 1,
                                newsletterName: 'MINI XD TECH'
                            }
                        }
                    }, { quoted: msg });
                }

                if (command === '.hidetag') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const participants = metadata.participants.map(p => p.id);
                    await sock.sendMessage(from!, { text: q || t('Tagging...', 'Tagging...'), mentions: participants }, { quoted: msg });
                }

                if (command === '.gcpp') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    try {
                        const ppUrl = await sock.profilePictureUrl(from!, 'image');
                        await sock.sendMessage(from!, { image: { url: ppUrl }, caption: t('*Photo du groupe !*', '*Group photo!*') }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Le groupe n\'a pas de photo de profil ou je ne peux pas y accéder.', '❌ The group has no profile picture or I cannot access it.'));
                    }
                }

                if (command.startsWith('.getpp')) {
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                                 (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null) ||
                                 sender;
                    if (!user) return await sendSimple(t('❌ Veuillez mentionner un utilisateur ou citer son message.', '❌ Please mention a user or quote their message.'));
                    try {
                        const ppUrl = await sock.profilePictureUrl(user, 'image');
                        await sock.sendMessage(from!, { image: { url: ppUrl }, caption: t(`*Photo de profil de @${user.split('@')[0]} !*`, `*Profile picture of @${user.split('@')[0]}!*`), mentions: [user] }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Cet utilisateur n\'a pas de photo de profil publique.', '❌ This user does not have a public profile picture.'));
                    }
                }

                if (command.startsWith('.opentime ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const min = parseInt(command.split(' ')[1]);
                    await sock.sendMessage(from!, { text: t(`*Le groupe s'ouvrira dans ${min} minutes !*`, `*The group will open in ${min} minutes!*`) }, { quoted: msg });
                    setTimeout(async () => {
                        await sock.groupSettingUpdate(from!, 'not_announcement');
                        await sock.sendMessage(from!, { text: t('*Groupe ouvert automatiquement !* 🔓', '*Group opened automatically!* 🔓') }, { quoted: msg });
                    }, min * 60000);
                }

                if (command.startsWith('.closetime ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const min = parseInt(command.split(' ')[1]);
                    await sock.sendMessage(from!, { text: t(`*Le groupe se fermera dans ${min} minutes !*`, `*The group will close in ${min} minutes!*`) }, { quoted: msg });
                    setTimeout(async () => {
                        await sock.groupSettingUpdate(from!, 'announcement');
                        await sock.sendMessage(from!, { text: t('*Groupe fermé automatiquement !* 🔒', '*Group closed automatically!* 🔒') }, { quoted: msg });
                    }, min * 60000);
                }

                // Outils Module
                if (command === '.outils' || command === 'outils') {
                    await sendStyled(`${t('🛠️ *OUTILS*', '🛠️ *TOOLS*')}\n\n🌸 .s / .sticker\n🌸 .toimg\n🌸 .translate\n🌸 .vv\n🌸 .status\n🌸 .play\n🌸 .alive\n🌸 .groupinfo\n🌸 .listgc`);
                }

                if (command === '.play' || command.startsWith('.play ')) {
                    if (!q) {
                        return sock.sendMessage(
                            from!,
                            { text: t("❌ Fournissez un nom de chanson ou une URL YouTube.", "❌ Provide a song name or YouTube URL.") },
                            { quoted: msg }
                        );
                    }

                    try {
                        await sock.sendMessage(from!, { react: { text: "🎵", key: msg.key } });
                    } catch {}

                    let waitMsgKey = null;
                    try {
                        const waitMsg = await sock.sendMessage(from!, { text: t("🎵 Veuillez patienter...", "🎵 Please wait...") }, { quoted: msg });
                        waitMsgKey = waitMsg.key;
                    } catch {}

                    let baseApi: string;
                    try {
                        const configRes = await axios.get("https://raw.githubusercontent.com/your-repo/config.json");
                        baseApi = configRes.data?.api;
                        if (!baseApi) throw new Error("Missing API URL in config");
                    } catch (err) {
                        if (waitMsgKey) {
                            try { await sock.sendMessage(from!, { delete: waitMsgKey }); } catch {}
                        }
                        return sock.sendMessage(
                            from!,
                            { text: t("❌ Échec de la récupération de la configuration de l'API depuis GitHub.", "❌ Failed to fetch API configuration from GitHub.") },
                            { quoted: msg }
                        );
                    }

                    try {
                        let videoUrl: string;
                        if (q.startsWith("http")) {
                            videoUrl = q;
                        } else {
                            const searchResults = await yts(q);
                            if (!searchResults?.videos.length) throw new Error("No results found.");
                            videoUrl = searchResults.videos[0].url;
                        }

                        const downloadApiUrl = `${baseApi}/play?url=${encodeURIComponent(videoUrl)}`;
                        const response = await axios.get(downloadApiUrl);
                        const data = response.data;

                        if (!data.status || !data.downloadUrl) throw new Error("API failed to return download URL.");

                        const safeTitle = data.title.replace(/[\\/:"*?<>|]/g, "");
                        const fileName = `${safeTitle}.mp3`;
                        const filePath = path.join(process.cwd(), fileName);

                        const audioBuffer = await axios.get(data.downloadUrl, { responseType: "arraybuffer" });
                        fs.writeFileSync(filePath, audioBuffer.data);

                        await sock.sendMessage(
                            from!,
                            {
                                audio: fs.readFileSync(filePath),
                                mimetype: "audio/mpeg",
                                fileName: fileName,
                                ptt: false
                            },
                            { quoted: msg }
                        );

                        try {
                            await sock.sendMessage(from!, { react: { text: "✅", key: msg.key } });
                        } catch {}

                        if (waitMsgKey) {
                            try { await sock.sendMessage(from!, { delete: waitMsgKey }); } catch {}
                        }

                        fs.unlinkSync(filePath);

                    } catch (err: any) {
                        console.error(err);
                        if (waitMsgKey) {
                            try { await sock.sendMessage(from!, { delete: waitMsgKey }); } catch {}
                        }
                        sock.sendMessage(
                            from!,
                            { text: t(`❌ Échec du téléchargement de la chanson : ${err.message}`, `❌ Failed to download song: ${err.message}`) },
                            { quoted: msg }
                        );
                        try {
                            await sock.sendMessage(from!, { react: { text: "❌", key: msg.key } });
                        } catch {}
                    }
                }

                if (command.startsWith('.weather ')) {
                    try {
                        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${q}&units=metric&appid=061f24e3538a499510083b5d8710dadc`);
                        const data = res.data;
                        const weatherText = `🌍 *${t('MÉTÉO', 'WEATHER')} : ${data.name}*\n\n🌡️ *${t('Temp', 'Temp')}* : ${data.main.temp}°C\n☁️ *${t('Ciel', 'Sky')}* : ${data.weather[0].description}\n💧 *${t('Humidité', 'Humidity')}* : ${data.main.humidity}%\n💨 *${t('Vent', 'Wind')}* : ${data.wind.speed} m/s`;
                        await sendStyled(weatherText);
                    } catch (e) {
                        await sendSimple(t('❌ Ville non trouvée.', '❌ City not found.'));
                    }
                }

                if (command.startsWith('.lyrics ')) {
                    try {
                        const res = await axios.get(`https://lyricstx.vercel.app/api/lyrics?q=${encodeURIComponent(q)}`);
                        if (res.data && res.data.lyrics) {
                            await sendStyled(`🎵 *LYRICS*\n\n✨ *${t('Titre', 'Title')}* : ${res.data.title || q}\n🎀 *${t('Artiste', 'Artist')}* : ${res.data.artist || t('Inconnu', 'Unknown')}\n\n${res.data.lyrics}`);
                        } else {
                            // Fallback to old API
                            const resOld = await axios.get(`https://api.lyrics.ovh/v1/${q.split('|')[0]}/${q.split('|')[1] || ''}`);
                            await sendStyled(`🎵 *LYRICS*\n\n${resOld.data.lyrics}`);
                        }
                    } catch (e) {
                        await sendSimple(t('❌ Paroles non trouvées.', '❌ Lyrics not found.'));
                    }
                }

                if (command.startsWith('.google ')) {
                    await sendStyled(`🔍 *GOOGLE SEARCH*\n\nhttps://www.google.com/search?q=${encodeURIComponent(q)}`);
                }

                if (command === '.tuto' || command === 'tuto') {
                    const tutoText = `╭─── 🍬 *${t('TUTORIEL MINI XD', 'MINI XD TUTORIAL')}* 🍬 ───╮
│
│ 🌟 *${t('Comment utiliser le bot ?', 'How to use the bot?')}*
│
│ 🎨 *Stickers* : 
│ Envoie une image avec *.s* ou cite une image.
│ Utilise *.setpack* et *.setauthor* pour personnaliser.
│
│ 🎵 *Musique* : 
│ Tape *.play* suivi du nom de la chanson.
│
│ 📥 *Téléchargement* : 
│ *.tiktok*, *.fbdown*, *.ytmp4* + lien.
│
│ 👥 *Groupe* : 
│ *.tagall* pour mentionner tout le monde.
│ *.hidetag* pour mentionner sans texte.
│ *.clear* pour nettoyer le groupe (Admins).
│
│ ⚙️ *Réglages* : 
│ *.lang fr/en* pour changer la langue.
│
╰───────────────────╯`;
                    await sendStyled(tutoText);
                }

                if (command === '.imagine') {
                    const prompt = q.trim();
                    if (!prompt) return await sendSimple(t("Veuillez fournir un prompt.", "Please provide a prompt."));

                    const wait = await sock.sendMessage(from!, { text: t("🎨 Génération de vos 4 images Imagine, veuillez patienter...", "🎨 Generating your 4 Imagine images, please wait...") }, { quoted: msg });

                    const tmpDir = path.join(process.cwd(), "cache");
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

                    try {
                        const baseApi = "https://azadx69x-all-apis-top.vercel.app/api/mj";
                        const response = await axios.get(`${baseApi}?prompt=${encodeURIComponent(prompt)}`);
                        const result = response.data;

                        if (!result.success || !result.data?.images?.length) {
                            throw new Error("API did not return any images.");
                        }

                        const imageUrls = result.data.images.slice(0, 4);
                        const buffers: Buffer[] = [];

                        for (const url of imageUrls) {
                            const res = await axios.get(url, { responseType: "arraybuffer" });
                            buffers.push(Buffer.from(res.data));
                        }

                        const canvas = createCanvas(1024, 1024);
                        const ctx = canvas.getContext("2d");
                        const images = await Promise.all(buffers.map(b => loadImage(b)));

                        ctx.drawImage(images[0], 0, 0, 512, 512);
                        ctx.drawImage(images[1], 512, 0, 512, 512);
                        ctx.drawImage(images[2], 0, 512, 512, 512);
                        ctx.drawImage(images[3], 512, 512, 512, 512);

                        const gridBuffer = canvas.toBuffer("image/png");
                        const gridPath = path.join(tmpDir, `mj_grid_${Date.now()}.png`);
                        fs.writeFileSync(gridPath, gridBuffer);

                        const sentMsg = await sock.sendMessage(from!, {
                            image: fs.readFileSync(gridPath),
                            caption: t(`🎨 *Imagine Image Grid*\n\n📝 *Prompt:* ${prompt}\n\n✨ _Répondez avec un chiffre (1-4) pour obtenir l'image individuelle en haute qualité._`, `🎨 *Imagine Image Grid*\n\n📝 *Prompt:* ${prompt}\n\n✨ _Reply with a number (1-4) to get the full quality individual image._`)
                        }, { quoted: msg });

                        onReply.push({
                            commandName: "imagine",
                            messageID: sentMsg?.key.id,
                            author: sender,
                            buffers: buffers,
                            prompt: prompt
                        });
                        if (onReply.length > 100) onReply.shift();

                        try { await sock.sendMessage(from!, { delete: wait?.key }); } catch (e) {}
                        fs.unlinkSync(gridPath);

                    } catch (e: any) {
                        console.error("[IMAGINE] Error:", e.message);
                        try { await sock.sendMessage(from!, { delete: wait?.key }); } catch (err) {}
                        await sendSimple(t("❌ Erreur lors de la génération des images : ", "❌ Error generating images: ") + e.message);
                    }
                }

                if (command === '.clear') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    if (!isAdmin) return await sendSimple(t('❌ Uniquement pour les admins !', '❌ Only for admins!'));
                    
                    const clearMsg = '.\n'.repeat(100) + t('🧹 *Chat effacé par l\'administrateur !*', '🧹 *Chat cleared by administrator!*');
                    await sendSimple(clearMsg);
                }

                if (command === '.del' || command === '.delete') {
                    if (!isAdmin) return await sendSimple(t('❌ Uniquement pour les admins !', '❌ Only for admins!'));
                    if (!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                        return await sendSimple(t('❌ Répondez à un message pour le supprimer !', '❌ Reply to a message to delete it!'));
                    }
                    const quotedKey = {
                        remoteJid: from,
                        fromMe: msg.message.extendedTextMessage.contextInfo.participant === sock.user?.id,
                        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                        participant: msg.message.extendedTextMessage.contextInfo.participant
                    };
                    await sock.sendMessage(from!, { delete: quotedKey });
                }

                if (command.startsWith('.setpack')) {
                    const packName = q.trim();
                    const currentPack = groupSettings['users']?.[sender!]?.packName || 'MINI-XD V2';
                    
                    if (!packName) {
                        return await sendStyled(t(`🌸 *Nom du pack actuel :* ${currentPack}\n\nUtilisez *.setpack <nom>* pour le changer.`, `🌸 *Current pack name:* ${currentPack}\n\nUse *.setpack <name>* to change it.`));
                    }
                    
                    if (!groupSettings['users']) groupSettings['users'] = {};
                    if (!groupSettings['users'][sender!]) groupSettings['users'][sender!] = {};
                    groupSettings['users'][sender!].packName = packName;
                    saveSettings();
                    await sendStyled(t(`✅ Nom du pack défini sur : *${packName}*`, `✅ Pack name set to: *${packName}*`));
                }

                if (command.startsWith('.setauthor ')) {
                    const authorName = q.trim();
                    if (!authorName) return await sendSimple(t('❌ Veuillez fournir un nom d\'auteur.', '❌ Please provide an author name.'));
                    if (!groupSettings['users']) groupSettings['users'] = {};
                    if (!groupSettings['users'][sender!]) groupSettings['users'][sender!] = {};
                    groupSettings['users'][sender!].authorName = authorName;
                    saveSettings();
                    await sendStyled(t(`✅ Nom de l'auteur défini sur : *${authorName}*`, `✅ Author name set to: *${authorName}*`));
                }

                if (command === '.s' || command === '.sticker' || command === 'sticker') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg = quoted || msg.message;
                    if (mediaMsg?.imageMessage || mediaMsg?.videoMessage) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '🎨', key: msg.key } });
                            // For quoted media, we need to pass the quoted message object correctly
                            const mediaToDownload = quoted ? { message: quoted } : msg;
                            const buffer = await downloadMediaMessage(mediaToDownload as any, 'buffer', {});
                            
                            const userPack = groupSettings['users']?.[sender!]?.packName || 'MINI-XD V2';
                            const userAuthor = groupSettings['users']?.[sender!]?.authorName || 'Samy Charles';
                            
                            const sticker = new Sticker(buffer, {
                                pack: userPack,
                                author: userAuthor,
                                type: StickerTypes.FULL,
                                id: '12345',
                                quality: 70,
                            });
                            await sock.sendMessage(from!, await sticker.toMessage(), { quoted: msg });
                        } catch (e) {
                            console.error('Sticker error:', e);
                            await sendSimple(t('❌ Erreur lors de la création du sticker.', '❌ Error creating sticker.'));
                        }
                    } else {
                        await sendSimple(t('❌ Veuillez envoyer ou citer une image/vidéo.', '❌ Please send or quote an image/video.'));
                    }
                }

                if (command === '.toimg') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const isSticker = quoted?.stickerMessage || msg.message?.stickerMessage;
                    if (isSticker) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '🖼️', key: msg.key } });
                            const mediaToDownload = quoted ? { 
                                message: quoted,
                                key: {
                                    remoteJid: from,
                                    fromMe: false,
                                    id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
                                    participant: msg.message?.extendedTextMessage?.contextInfo?.participant
                                }
                            } : msg;
                            const buffer = await downloadMediaMessage(mediaToDownload as any, 'buffer', {});
                            await sock.sendMessage(from!, { image: buffer, caption: t('*Sticker converti !*', '*Sticker converted!*') }, { quoted: msg });
                        } catch (e) {
                            console.error('Toimg error:', e);
                            await sendSimple(t('❌ Erreur lors de la conversion du sticker.', '❌ Error converting sticker.'));
                        }
                    } else {
                        await sendSimple(t('❌ Veuillez citer un sticker.', '❌ Please quote a sticker.'));
                    }
                }

                if (command.startsWith('.translate ')) {
                    const lang = command.split(' ')[1];
                    const text = q.replace(lang, '').trim();
                    const res = await translate(text, { to: lang });
                    await sock.sendMessage(from!, { text: t(`*Traduction (${lang}) :*\n\n${res.text}`, `*Translation (${lang}):*\n\n${res.text}`) }, { quoted: msg });
                }

                if (command === '.vv' || command === 'vv') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const isViewOnce = quoted?.viewOnceMessageV2 || quoted?.viewOnceMessage || quoted?.viewOnceMessageV2Extension || 
                                     msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2Extension;
                    
                    if (isViewOnce || quoted) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '👁️', key: msg.key } });
                            const mediaToDownload = quoted ? { 
                                message: quoted,
                                key: {
                                    remoteJid: from,
                                    fromMe: false,
                                    id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
                                    participant: msg.message?.extendedTextMessage?.contextInfo?.participant
                                }
                            } : msg;
                            const buffer = await downloadMediaMessage(mediaToDownload as any, 'buffer', {});
                            
                            let content = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message || quoted?.viewOnceMessageV2Extension?.message ||
                                          msg.message?.viewOnceMessageV2?.message || msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2Extension?.message ||
                                          quoted || msg.message;
                            
                            // Handle nested viewOnce
                            if (content?.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
                            if (content?.viewOnceMessage) content = content.viewOnceMessage.message;
 
                            const type = Object.keys(content || {})[0];
                            const contextInfo = {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363406104843715@newsletter',
                                    serverMessageId: 1,
                                    newsletterName: 'MINI XD TECH'
                                }
                            };
                            
                            if (type === 'imageMessage') {
                                await sock.sendMessage(from!, { image: buffer, caption: t('*Contenu récupéré !*', '*Content recovered!*'), contextInfo }, { quoted: msg });
                            } else if (type === 'videoMessage') {
                                await sock.sendMessage(from!, { video: buffer, caption: t('*Contenu récupéré !*', '*Content recovered!*'), contextInfo }, { quoted: msg });
                            } else if (type === 'stickerMessage') {
                                // If it's a sticker, convert to image as requested
                                await sock.sendMessage(from!, { image: buffer, caption: t('*Sticker converti !*', '*Sticker converted!*'), contextInfo }, { quoted: msg });
                            } else if (type === 'audioMessage') {
                                await sock.sendMessage(from!, { audio: buffer, mimetype: 'audio/mp4', contextInfo }, { quoted: msg });
                            } else {
                                await sendSimple(t('❌ Type de média non supporté.', '❌ Media type not supported.'));
                            }
                        } catch (e) {
                            console.error('VV error:', e);
                            await sendSimple(t('❌ Erreur lors de la récupération du contenu.', '❌ Error recovering content.'));
                        }
                    } else {
                        await sendSimple(t('❌ Veuillez citer un message "vue unique" ou un média.', '❌ Please quote a "view once" message or media.'));
                    }
                }

                if (command === '.status' || command === 'status') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const mediaMsg = quoted || msg.message;
                    if (mediaMsg?.imageMessage || mediaMsg?.videoMessage) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '📥', key: msg.key } });
                            const mediaToDownload = quoted ? { 
                                message: quoted,
                                key: {
                                    remoteJid: from,
                                    fromMe: false,
                                    id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
                                    participant: msg.message?.extendedTextMessage?.contextInfo?.participant
                                }
                            } : msg;
                            const buffer = await downloadMediaMessage(mediaToDownload as any, 'buffer', {});
                            const type = Object.keys(mediaMsg)[0];
                            const contextInfo = {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363406104843715@newsletter',
                                    serverMessageId: 1,
                                    newsletterName: 'MINI XD TECH'
                                }
                            };
                            if (type === 'imageMessage') {
                                await sock.sendMessage(from!, { image: buffer, caption: t('*Status récupéré !*', '*Status recovered!*'), contextInfo }, { quoted: msg });
                            } else if (type === 'videoMessage') {
                                await sock.sendMessage(from!, { video: buffer, caption: t('*Status récupéré !*', '*Status recovered!*'), contextInfo }, { quoted: msg });
                            }
                        } catch (e) {
                            console.error('Status error:', e);
                            await sendSimple(t('❌ Erreur lors de la récupération du status.', '❌ Error recovering status.'));
                        }
                    } else {
                        await sendSimple(t('❌ Veuillez citer ou envoyer un média de status.', '❌ Please quote or send a status media.'));
                    }
                }

                if (command === '.alive') {
                    await sock.sendMessage(from!, { text: t('*OUI JE SUIS EN LIGNE !* 🚀🌸', '*YES I AM ONLINE!* 🚀🌸') }, { quoted: msg });
                }

                if (command === '.del') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (quoted) {
                        await sock.sendMessage(from!, { delete: { remoteJid: from, fromMe: false, id: quoted.stanzaId, participant: quoted.participant } });
                    } else {
                        await sendSimple(t('❌ Veuillez citer un message à supprimer.', '❌ Please quote a message to delete.'));
                    }
                }

                if (command === '.admins') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const admins = metadata.participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`);
                    await sendStyled(t(`👑 *ADMINS DU GROUPE*\n\n${admins.join('\n')}`, `👑 *GROUP ADMINS*\n\n${admins.join('\n')}`), admins.map(a => a.replace('@', '') + '@s.whatsapp.net'));
                }

                if (command === '.invite') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const code = await sock.groupInviteCode(from!);
                    await sendStyled(t(`📩 *INVITATION*\n\nhttps://chat.whatsapp.com/${code}`, `📩 *INVITATION*\n\nhttps://chat.whatsapp.com/${code}`));
                }

                if (command === '.revoke') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sock.groupRevokeInvite(from!);
                    await sendStyled(t('✅ Lien d\'invitation réinitialisé !', '✅ Invitation link reset!'));
                }

                if (command.startsWith('.warn ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null);
                    if (!user) return await sendSimple(t('❌ Mentionnez quelqu\'un.', '❌ Mention someone.'));
                    const warns = (groupSettings[from!]?.warns || {});
                    warns[user] = (warns[user] || 0) + 1;
                    if (!groupSettings[from!]) groupSettings[from!] = {};
                    groupSettings[from!].warns = warns;
                    saveSettings();
                    await sendStyled(t(`⚠️ *AVERTISSEMENT*\n\n@${user.split('@')[0]} a maintenant ${warns[user]} avertissement(s).`, `⚠️ *WARNING*\n\n@${user.split('@')[0]} now has ${warns[user]} warning(s).`), [user]);
                    if (warns[user] >= 3) {
                        await sock.groupParticipantsUpdate(from!, [user], 'remove');
                        await sendStyled(t(`🚫 @${user.split('@')[0]} a été expulsé pour avoir atteint 3 avertissements.`, `🚫 @${user.split('@')[0]} was expelled for reaching 3 warnings.`), [user]);
                        delete warns[user];
                        saveSettings();
                    }
                }

                if (command.startsWith('.resetwarn ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null);
                    if (!user) return await sendSimple(t('❌ Mentionnez quelqu\'un.', '❌ Mention someone.'));
                    if (groupSettings[from!]?.warns) {
                        delete groupSettings[from!].warns[user];
                        saveSettings();
                        await sendStyled(t(`✅ Avertissements réinitialisés pour @${user.split('@')[0]} !`, `✅ Warnings reset for @${user.split('@')[0]}!`), [user]);
                    }
                }

                if (command === '.calc' || command.startsWith('.calc ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une expression.', '❌ Please provide an expression.'));
                    try {
                        const result = eval(q);
                        await sendStyled(t(`🔢 *CALCUL*\n\n✨ *Expression* : ${q}\n🎀 *Résultat* : ${result}`, `🔢 *CALCULATION*\n\n✨ *Expression*: ${q}\n🎀 *Result*: ${result}`));
                    } catch (e) {
                        await sendSimple(t('❌ Expression invalide.', '❌ Invalid expression.'));
                    }
                }

                if (command === '.add' || command.startsWith('.add ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un numéro.', '❌ Please provide a number.'));
                    const user = q.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    try {
                        await sock.groupParticipantsUpdate(from!, [user], 'add');
                        await sendStyled(t(`✅ Utilisateur ajouté !`, `✅ User added!`));
                    } catch (e) {
                        await sendSimple(t('❌ Impossible d\'ajouter l\'utilisateur. Vérifiez si je suis admin.', '❌ Unable to add user. Check if I am admin.'));
                    }
                }

                if (command === '.kick' || command.startsWith('.kick ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null);
                    if (!user) return await sendSimple(t('❌ Mentionnez quelqu\'un.', '❌ Mention someone.'));
                    try {
                        await sock.groupParticipantsUpdate(from!, [user], 'remove');
                        await sendStyled(t(`✅ Utilisateur expulsé !`, `✅ User expelled!`));
                    } catch (e) {
                        await sendSimple(t('❌ Impossible d\'expulser l\'utilisateur.', '❌ Unable to expel user.'));
                    }
                }

                if (command === '.promote' || command.startsWith('.promote ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null);
                    if (!user) return await sendSimple(t('❌ Mentionnez quelqu\'un.', '❌ Mention someone.'));
                    try {
                        await sock.groupParticipantsUpdate(from!, [user], 'promote');
                        await sendStyled(t(`✅ Utilisateur promu admin !`, `✅ User promoted to admin!`));
                    } catch (e) {
                        await sendSimple(t('❌ Impossible de promouvoir l\'utilisateur.', '❌ Unable to promote user.'));
                    }
                }

                if (command === '.demote' || command.startsWith('.demote ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const user = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null);
                    if (!user) return await sendSimple(t('❌ Mentionnez quelqu\'un.', '❌ Mention someone.'));
                    try {
                        await sock.groupParticipantsUpdate(from!, [user], 'demote');
                        await sendStyled(t(`✅ Utilisateur destitué !`, `✅ User demoted!`));
                    } catch (e) {
                        await sendSimple(t('❌ Impossible de destituer l\'utilisateur.', '❌ Unable to demote user.'));
                    }
                }

                if (command === '.ephemeral') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sock.sendMessage(from!, { text: t('✅ Messages éphémères activés (24h).', '✅ Ephemeral messages enabled (24h).') }, { ephemeralExpiration: 86400, quoted: msg });
                }

                // Manga & Anime Commands
                if (command.startsWith('.manga ')) {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(q)}&limit=1`);
                        const manga = res.data.data[0];
                        if (!manga) return await sendSimple(t('❌ Manga non trouvé.', '❌ Manga not found.'));
                        await sock.sendMessage(from!, { 
                            image: { url: manga.images.jpg.image_url }, 
                            caption: `📚 *MANGA*\n\n✨ *${t('Titre', 'Title')}* : ${manga.title}\n🎀 *${t('Auteur', 'Author')}* : ${manga.authors.map((a: any) => a.name).join(', ')}\n🌸 *${t('Genres', 'Genres')}* : ${manga.genres.map((g: any) => g.name).join(', ')}\n🧚 *${t('Volumes', 'Volumes')}* : ${manga.volumes || 'N/A'}\n✨ *${t('Lien', 'Link')}* : ${manga.url}`
                        }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command.startsWith('.anime ')) {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=1`);
                        const anime = res.data.data[0];
                        if (!anime) return await sendSimple(t('❌ Anime non trouvé.', '❌ Anime not found.'));
                        await sock.sendMessage(from!, { 
                            image: { url: anime.images.jpg.image_url }, 
                            caption: `⛩️ *ANIME*\n\n✨ *${t('Titre', 'Title')}* : ${anime.title}\n🎀 *${t('Studio', 'Studio')}* : ${anime.studios.map((s: any) => s.name).join(', ')}\n🌸 *${t('Genres', 'Genres')}* : ${anime.genres.map((g: any) => g.name).join(', ')}\n🧚 *${t('Épisodes', 'Episodes')}* : ${anime.episodes || 'N/A'}\n✨ *${t('Lien', 'Link')}* : ${anime.url}`
                        }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command.startsWith('.character ')) {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(q)}&limit=1`);
                        const char = res.data.data[0];
                        if (!char) return await sendSimple(t('❌ Personnage non trouvé.', '❌ Character not found.'));
                        await sock.sendMessage(from!, { 
                            image: { url: char.images.jpg.image_url }, 
                            caption: `👤 *CHARACTER*\n\n✨ *${t('Nom', 'Name')}* : ${char.name}\n🎀 *About* : ${char.about?.substring(0, 500) || 'N/A'}...\n✨ *${t('Lien', 'Link')}* : ${char.url}`
                        }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command === '.topmanga') {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/top/manga?limit=5`);
                        const list = res.data.data.map((m: any, i: number) => `${i+1}. ${m.title} (${m.score})`).join('\n');
                        await sendStyled(`🏆 *TOP 5 MANGA*\n\n${list}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command === '.topanime') {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/top/anime?limit=5`);
                        const list = res.data.data.map((a: any, i: number) => `${i+1}. ${a.title} (${a.score})`).join('\n');
                        await sendStyled(`🏆 *TOP 5 ANIME*\n\n${list}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command === '.upcoming') {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/seasons/upcoming?limit=5`);
                        const list = res.data.data.map((a: any, i: number) => `${i+1}. ${a.title}`).join('\n');
                        await sendStyled(`🆕 *${t('ANIME À VENIR', 'UPCOMING ANIME')}*\n\n${list}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command === '.airing') {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/seasons/now?limit=5`);
                        const list = res.data.data.map((a: any, i: number) => `${i+1}. ${a.title}`).join('\n');
                        await sendStyled(`📺 *${t('ANIME EN COURS', 'AIRING ANIME')}*\n\n${list}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command === '.recommend') {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/recommendations/anime?limit=5`);
                        const list = res.data.data.map((r: any, i: number) => `${i+1}. ${r.entry[0].title}`).join('\n');
                        await sendStyled(`💡 *RECOMMANDATIONS*\n\n${list}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command.startsWith('.mangainfo ')) {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(q)}&limit=1`);
                        const manga = res.data.data[0];
                        if (!manga) return await sendSimple(t('❌ Manga non trouvé.', '❌ Manga not found.'));
                        await sendStyled(`📚 *${t('INFO MANGA', 'MANGA INFO')}*\n\n✨ *${t('Titre', 'Title')}* : ${manga.title}\n🎀 *${t('Auteur', 'Author')}* : ${manga.authors.map((a: any) => a.name).join(', ')}\n🌸 *${t('Genres', 'Genres')}* : ${manga.genres.map((g: any) => g.name).join(', ')}\n🧚 *${t('Volumes', 'Volumes')}* : ${manga.volumes || 'N/A'}\n✨ *${t('Lien', 'Link')}* : ${manga.url}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command.startsWith('.animeinfo ')) {
                    try {
                        const res = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=1`);
                        const anime = res.data.data[0];
                        if (!anime) return await sendSimple(t('❌ Anime non trouvé.', '❌ Anime not found.'));
                        await sendStyled(`🎬 *${t('INFO ANIME', 'ANIME INFO')}*\n\n✨ *${t('Titre', 'Title')}* : ${anime.title}\n🎀 *${t('Studio', 'Studio')}* : ${anime.studios.map((s: any) => s.name).join(', ')}\n🌸 *${t('Source', 'Source')}* : ${anime.source}\n🧚 *${t('Note', 'Rating')}* : ${anime.rating}\n✨ *${t('Lien', 'Link')}* : ${anime.url}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur.', '❌ Error.'));
                    }
                }

                if (command.startsWith('.qr ')) {
                    await sock.sendMessage(from!, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(q)}` }, caption: t(`*QR Code pour : ${q}*`, `*QR Code for: ${q}*`) }, { quoted: msg });
                }

                if (command === '.wiki' || command.startsWith('.wiki ')) {
                    const res = await axios.get(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
                    await sendStyled(`📚 *WIKIPEDIA*\n\n✨ *${t('Titre', 'Title')}* : ${res.data.title}\n\n${res.data.extract}`);
                }

                if (command === '.shortlink' || command.startsWith('.shortlink ')) {
                    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`);
                    await sendStyled(`🔗 *${t('LIEN COURT', 'SHORT LINK')}*\n\n${res.data}`);
                }

                if (command.startsWith('.ssweb ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une URL.', '❌ Please provide a URL.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '📸', key: msg.key } });
                        const url = q.startsWith('http') ? q : `https://${q}`;
                        const ssUrl = `https://api.screenshotmachine.com/?key=a96324&url=${encodeURIComponent(url)}&dimension=1024x768`;
                        await sock.sendMessage(from!, { image: { url: ssUrl }, caption: t(`✨ *CAPTURE D'ÉCRAN* ✨\n\n🔗 *URL* : ${url}`, `✨ *SCREENSHOT* ✨\n\n🔗 *URL*: ${url}`) }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors de la capture d\'écran.', '❌ Error during screenshot.'));
                    }
                }

                if (command.startsWith('.tinyurl ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une URL.', '❌ Please provide a URL.'));
                    try {
                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`);
                        await sendStyled(`🔗 *TINYURL*\n\n${res.data}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du raccourcissement.', '❌ Error during shortening.'));
                    }
                }

                if (command.startsWith('.bitly ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une URL.', '❌ Please provide a URL.'));
                    try {
                        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`);
                        await sendStyled(`🔗 *BITLY*\n\n${res.data}`);
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du raccourcissement.', '❌ Error during shortening.'));
                    }
                }

                if (command === '.remini' || command === '.hd' || command === 'hd') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
                    const imageMsg = quoted?.imageMessage || quoted?.viewOnceMessageV2?.message?.imageMessage || quoted?.viewOnceMessageV2Extension?.message?.imageMessage;
                    
                    if (imageMsg) {
                        try {
                            await sock.sendMessage(from!, { react: { text: '✨', key: msg.key } });
                            const buffer = await downloadMediaMessage({ message: quoted } as any, 'buffer', {});
                            let url = await uploadToCatbox(buffer);
                            
                            if (!url || typeof url !== 'string' || !url.startsWith('http')) {
                                return await sendStyled('❌ Erreur lors de l\'upload de l\'image sur Catbox.');
                            }
                            
                            url = url.trim();
                            let success = false;
                            
                            // Try API 1: Maher Zubair
                            try {
                                const res = await axios.get(`https://api.maher-zubair.tech/remini?url=${encodeURIComponent(url)}`);
                                if (res.data?.status === 200 && res.data?.result) {
                                    await sock.sendMessage(from!, { 
                                        image: { url: res.data.result }, 
                                        caption: '*✨ Image améliorée en HD ✨*' 
                                    }, { quoted: msg });
                                    await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                    success = true;
                                }
                            } catch (e) {
                                console.log('Maher Zubair API failed');
                            }
                            
                            // Try API 2: Gifted (Fallback)
                            if (!success) {
                                try {
                                    const giftedRes = await axios.get(`https://api.giftedtech.my.id/api/tools/remini?url=${encodeURIComponent(url)}&apikey=gifted`);
                                    if (giftedRes.data?.result?.download_url) {
                                        await sock.sendMessage(from!, { 
                                            image: { url: giftedRes.data.result.download_url }, 
                                            caption: '*✨ Image améliorée en HD ✨*' 
                                        }, { quoted: msg });
                                        await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                        success = true;
                                    }
                                } catch (e) {
                                    console.log('Gifted API failed');
                                }
                            }

                            // Try API 3: Vreden (Fallback)
                            if (!success) {
                                try {
                                    const vredenRes = await axios.get(`https://api.vreden.my.id/api/remini?url=${encodeURIComponent(url)}`);
                                    if (vredenRes.data?.status && vredenRes.data?.result) {
                                        await sock.sendMessage(from!, { 
                                            image: { url: vredenRes.data.result }, 
                                            caption: '*✨ Image améliorée en HD ✨*' 
                                        }, { quoted: msg });
                                        await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                        success = true;
                                    }
                                } catch (e) {
                                    console.log('Vreden API failed');
                                }
                            }

                            // Try API 4: Shizuka (Fallback)
                            if (!success) {
                                try {
                                    const shizukaRes = await axios.get(`https://api.shizuka.site/remini?url=${encodeURIComponent(url)}`);
                                    if (shizukaRes.data?.status === 200 && shizukaRes.data?.result) {
                                        await sock.sendMessage(from!, { 
                                            image: { url: shizukaRes.data.result }, 
                                            caption: '*✨ Image améliorée en HD ✨*' 
                                        }, { quoted: msg });
                                        await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                        success = true;
                                    }
                                } catch (e) {
                                    console.log('Shizuka API failed');
                                }
                            }
                            
                            if (!success) {
                                await sendSimple('❌ Toutes les APIs d\'amélioration ont échoué. Réessayez plus tard.');
                                await sock.sendMessage(from!, { react: { text: '❌', key: msg.key } });
                            }
                        } catch (e: any) {
                            console.error('HD command failed:', e.message || e);
                            await sendSimple('❌ Une erreur est survenue lors du traitement.');
                        }
                    } else {
                        await sendSimple('❌ Veuillez citer une image pour l\'améliorer en HD.');
                    }
                }

                if (command === '.ocr') {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quoted?.imageMessage) {
                        await sendStyled('🔍 *OCR*\n\nAnalyse en cours... (Nécessite une API externe)');
                    }
                }

                if (command === '.kickme') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sendStyled(t('👋 Au revoir !', '👋 Goodbye!'));
                    await sock.groupParticipantsUpdate(from!, [sender!], 'remove');
                }

                if (command === '.leave') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    await sendStyled(t('👋 Le bot quitte le groupe.', '👋 The bot is leaving the group.'));
                    await sock.groupLeave(from!);
                }

                if (command === '.tagadmin') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
                    await sock.sendMessage(from!, { text: t('📢 *Appel aux Admins !*', '📢 *Calling Admins!*'), mentions: admins }, { quoted: msg });
                }

                if (command === '.npm' || command.startsWith('.npm ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un nom de package.', '❌ Please provide a package name.'));
                    try {
                        const res = await axios.get(`https://registry.npmjs.org/${q}`);
                        const data = res.data;
                        await sendStyled(`📦 *NPM PACKAGE*\n\n✨ *${t('Nom', 'Name')}* : ${data.name}\n🎀 *${t('Version', 'Version')}* : ${data['dist-tags'].latest}\n🌸 *${t('Description', 'Description')}* : ${data.description}\n🧚 *${t('Lien', 'Link')}* : https://www.npmjs.com/package/${data.name}`);
                    } catch (e) {
                        await sendSimple(t('❌ Paquet non trouvé.', '❌ Package not found.'));
                    }
                }

                if (command === '.github' || command.startsWith('.github ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un nom d\'utilisateur.', '❌ Please provide a username.'));
                    try {
                        const res = await axios.get(`https://api.github.com/users/${q}`);
                        const data = res.data;
                        await sock.sendMessage(from!, { 
                            image: { url: data.avatar_url }, 
                            caption: `🐙 *GITHUB PROFILE*\n\n✨ *${t('Nom', 'Name')}* : ${data.name || data.login}\n🎀 *${t('Bio', 'Bio')}* : ${data.bio || t('Aucune', 'None')}\n🌸 *Repos* : ${data.public_repos}\n🧚 *Followers* : ${data.followers}\n✨ *${t('Lien', 'Link')}* : ${data.html_url}`
                        }, { quoted: msg });
                    } catch (e) {
                        await sendSimple(t('❌ Utilisateur non trouvé.', '❌ User not found.'));
                    }
                }

                if (command === '.define' || command.startsWith('.define ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un mot.', '❌ Please provide a word.'));
                    try {
                        const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${q}`);
                        const data = res.data[0];
                        await sendStyled(`📖 *${t('DICTIONNAIRE', 'DICTIONARY')}*\n\n✨ *${t('Mot', 'Word')}* : ${data.word}\n🎀 *${t('Phonétique', 'Phonetic')}* : ${data.phonetic || 'N/A'}\n🌸 *${t('Définition', 'Definition')}* : ${data.meanings[0].definitions[0].definition}`);
                    } catch (e) {
                        await sendSimple(t('❌ Mot non trouvé.', '❌ Word not found.'));
                    }
                }

                if (command.startsWith('.tiktok ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une URL TikTok.', '❌ Please provide a TikTok URL.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '📥', key: msg.key } });
                        const res = await axios.get(`https://api.vreden.my.id/api/tiktok?url=${encodeURIComponent(q)}`);
                        if (res.data?.status && res.data?.result?.video) {
                            await sock.sendMessage(from!, { video: { url: res.data.result.video }, caption: res.data.result.title || 'TikTok' }, { quoted: msg });
                        } else {
                            await sendSimple(t('❌ Impossible de télécharger cette vidéo.', '❌ Unable to download this video.'));
                        }
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du téléchargement TikTok.', '❌ Error during TikTok download.'));
                    }
                }

                if (command.startsWith('.fbdown ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir une URL Facebook.', '❌ Please provide a Facebook URL.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '📥', key: msg.key } });
                        const res = await axios.get(`https://api.vreden.my.id/api/facebook?url=${encodeURIComponent(q)}`);
                        if (res.data?.status && res.data?.result?.video) {
                            await sock.sendMessage(from!, { video: { url: res.data.result.video }, caption: 'Facebook Video' }, { quoted: msg });
                        } else {
                            await sendSimple(t('❌ Impossible de télécharger cette vidéo.', '❌ Unable to download this video.'));
                        }
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du téléchargement Facebook.', '❌ Error during Facebook download.'));
                    }
                }

                if (command.startsWith('.igstalk ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un nom d\'utilisateur Instagram.', '❌ Please provide an Instagram username.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '🔍', key: msg.key } });
                        const res = await axios.get(`https://api.vreden.my.id/api/igstalk?username=${encodeURIComponent(q)}`);
                        if (res.data?.status && res.data?.result) {
                            const r = res.data.result;
                            const info = `👤 *INSTAGRAM STALK*\n\n✨ *${t('Nom', 'Name')}* : ${r.fullName}\n🎀 *User* : ${r.username}\n🌸 *Bio* : ${r.biography}\n🧚 *${t('Abonnés', 'Followers')}* : ${r.followers}\n✨ *${t('Abonnements', 'Following')}* : ${r.following}\n🎀 *Posts* : ${r.postsCount}`;
                            await sock.sendMessage(from!, { image: { url: r.profilePic }, caption: info }, { quoted: msg });
                        } else {
                            await sendSimple(t('❌ Utilisateur non trouvé.', '❌ User not found.'));
                        }
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du stalk Instagram.', '❌ Error during Instagram stalk.'));
                    }
                }

                if (command === '.ytmp4' || command.startsWith('.ytmp4 ')) {
                    if (!q) return await sendSimple(t('❌ Veuillez fournir un lien YouTube.', '❌ Please provide a YouTube link.'));
                    try {
                        await sock.sendMessage(from!, { react: { text: '🎥', key: msg.key } });
                        const search = await yts(q);
                        const video = search.videos[0];
                        if (!video) return await sendSimple(t('❌ Aucun résultat trouvé.', '❌ No results found.'));

                        await sendStyled(`🎥 *${t('TÉLÉCHARGEMENT VIDÉO', 'VIDEO DOWNLOAD')}*\n\n✨ *${t('Titre', 'Title')}* : ${video.title}\n🧚 *${t('Lien', 'Link')}* : ${video.url}`);

                        let success = false;
                        
                        // Try API 1: Dreaded
                        try {
                            const dreadedUrl = `https://api.dreaded.site/api/ytdl/video?url=${encodeURIComponent(video.url)}`;
                            const res = await axios.get(dreadedUrl);
                            if (res.data?.result?.download_url) {
                                await sock.sendMessage(from!, { 
                                    video: { url: res.data.result.download_url }, 
                                    caption: video.title
                                }, { quoted: msg });
                                await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                success = true;
                            }
                        } catch (e) {
                            console.log('Dreaded API failed');
                        }

                        // Try API 2: Gifted (Fallback)
                        if (!success) {
                            try {
                                const giftedUrl = `https://api.giftedtech.my.id/api/download/ytmp4?url=${encodeURIComponent(video.url)}&apikey=gifted`;
                                const res = await axios.get(giftedUrl);
                                if (res.data?.result?.download_url) {
                                    await sock.sendMessage(from!, { 
                                        video: { url: res.data.result.download_url }, 
                                        caption: video.title
                                    }, { quoted: msg });
                                    await sock.sendMessage(from!, { react: { text: '✅', key: msg.key } });
                                    success = true;
                                }
                            } catch (e) {
                                console.log('Gifted API failed');
                            }
                        }

                        if (!success) {
                            await sendSimple(t('❌ Erreur lors du téléchargement.', '❌ Error during download.'));
                        }
                    } catch (e) {
                        await sendSimple(t('❌ Erreur lors du téléchargement.', '❌ Error during download.'));
                    }
                }

                if (command.startsWith('.setwelcome ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    settings.welcomeText = q;
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sendStyled(t(`✅ Message de bienvenue mis à jour :\n\n${q}`, `✅ Welcome message updated:\n\n${q}`));
                }

                if (command.startsWith('.setgoodbye ')) {
                    const mode = command.split(' ')[1];
                    settings.goodbye = mode === 'on';
                    groupSettings[from!] = settings;
                    saveSettings();
                    await sock.sendMessage(from!, { text: t(`*Goodbye ${mode === 'on' ? 'activé' : 'désactivé'} !*`, `*Goodbye ${mode === 'on' ? 'enabled' : 'disabled'} !*`) }, { quoted: msg });
                }

                if (['.waifu', '.neko', '.shinobu', '.megumin'].includes(command)) {
                    const type = command.replace('.', '');
                    const res = await axios.get(`https://api.waifu.pics/sfw/${type}`);
                    await sock.sendMessage(from!, { image: { url: res.data.url } }, { quoted: msg });
                }

                // Bot Info Module
                if (command === '.botinfo' || command === 'botinfo') {
                    await sendStyled(t('ℹ️ *INFOS BOT*', 'ℹ️ *BOT INFO*') + `\n\n🌸 .botstatus\n🌸 .uptime`);
                }

                if (command === '.botstatus') {
                    const isAlwaysOnline = groupSettings['global']?.alwaysOnline !== false;
                    const isPublic = groupSettings['global']?.public !== false;
                    const chatbot = groupSettings['global']?.chatbot === true;
                    const lang = groupSettings['global']?.language || 'fr';
                    
                    const statusText = `*🌸 ─── 🍬 BOT STATUS 🍬 ─── 🌸*

✨ *₊·( ✰ ) ${t('Mᧉɱσırᧉ', 'Mᧉɱσry')}* » *${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB*
🎀 *₊·( ✰ ) ${t('Plαtᧉfσrɱᧉ', 'Plαtfσrɱ')}* » *${process.platform}*
🌸 *₊·( ✰ ) ${t('Vᧉrsıσn Nσdᧉ', 'Nσdᧉ Vᧉrsıσn')}* » *${process.version}*
🧚 *₊·( ✰ ) Always Online* » *${isAlwaysOnline ? 'ON ✅' : 'OFF ❌'}*
✨ *₊·( ✰ ) Mode* » *${isPublic ? 'PUBLIC 🌍' : 'PRIVATE 🔒'}*
🎀 *₊·( ✰ ) Chatbot* » *${chatbot ? 'ON 🤖' : 'OFF ❌'}*
🌸 *₊·( ✰ ) Language* » *${lang.toUpperCase()}*
🧚 *₊·( ✰ ) Uρtıɱᧉ* » *${getUptime()}*

> *🧚 MINI-XD V2 🧚*`;
                    await sendStyled(statusText);
                }

                if (command === '.uptime') {
                    await sendStyled(t('⏳ *TEMPS DE FONCTIONNEMENT*', '⏳ *RUNTIME*') + `\n\n${getUptime()}`);
                }

                if (command === '.quote') {
                    const res = await axios.get('https://api.quotable.io/random');
                    await sendStyled(`📜 *${t('CITATION', 'QUOTE')}*\n\n"${res.data.content}"\n\n- ${res.data.author}`);
                }

                if (command === '.fact') {
                    const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
                    await sendStyled(`💡 *${t('LE SAVAIS-TU ?', 'DID YOU KNOW ?')}*\n\n${res.data.text}`);
                }

                if (command === '.joke') {
                    const res = await axios.get('https://official-joke-api.appspot.com/random_joke');
                    await sendStyled(`😂 *${t('BLAGUE', 'JOKE')}*\n\n${res.data.setup}\n\n... ${res.data.punchline}`);
                }

                if (command === '.couple') {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const metadata = await sock.groupMetadata(from!);
                    const participants = metadata.participants;
                    const user1 = participants[Math.floor(Math.random() * participants.length)].id;
                    const user2 = participants[Math.floor(Math.random() * participants.length)].id;
                    await sock.sendMessage(from!, { text: t(`👩‍❤️‍👨 *COUPLE DU JOUR*\n\n@${user1.split('@')[0]} ❤️ @${user2.split('@')[0]}`, `👩‍❤️‍👨 *COUPLE OF THE DAY*\n\n@${user1.split('@')[0]} ❤️ @${user2.split('@')[0]}`), mentions: [user1, user2] }, { quoted: msg });
                }

                if (command.startsWith('.ship ')) {
                    if (!isGroup) return await sendSimple(t('❌ Uniquement en groupe !', '❌ Only in groups!'));
                    const users = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    if (users.length < 2) return await sendSimple(t('❌ Mentionnez deux personnes !', '❌ Mention two people!'));
                    const love = Math.floor(Math.random() * 100);
                    await sendStyled(t(`💖 *SHIP*\n\n@${users[0].split('@')[0]} + @${users[1].split('@')[0]}\n\n🔥 *Amour* : ${love}%`, `💖 *SHIP*\n\n@${users[0].split('@')[0]} + @${users[1].split('@')[0]}\n\n🔥 *Love* : ${love}%`));
                }

                if (command === '.ping') {
                    const start = Date.now();
                    await sock.sendMessage(from!, { text: t('Pinging...', 'Pinging...') }, { quoted: msg });
                    const end = Date.now();
                    const latency = end - start;
                    
                    await sock.sendMessage(from!, { 
                        text: `*₊·( ✰ ) Lαtᧉncıα* » *${latency} ms*`,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363406104843715@newsletter',
                                serverMessageId: 1,
                                newsletterName: 'MINI XD TECH'
                            }
                        }
                    }, { quoted: msg });
                    
                    // Pin logic: pin the quoted message if it exists, otherwise pin the command message
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    try {
                        const targetKey = quoted?.stanzaId ? {
                            remoteJid: from,
                            fromMe: false,
                            id: quoted.stanzaId,
                            participant: quoted.participant
                        } : msg.key;
                        
                        await sock.sendMessage(from!, { pin: targetKey } as any);
                    } catch (e) {
                        console.error('Failed to pin:', e);
                    }
                }

                if (command === '.runtime') {
                    await sendStyled(t('⏳ *TEMPS DE FONCTIONNEMENT*', '⏳ *RUNTIME*') + `\n\n${getUptime()}`);
                }
            } catch (err) {
                console.error('Error in messages.upsert:', err);
            }
            });

            if (res) {
                if (!sock.authState.creds.registered) {
                    if (res.qr) {
                        console.log(`Waiting for QR code for ${cleanPhone}...`);
                        return;
                    }
                    console.log(`Requesting real pairing code from Baileys for ${cleanPhone}...`);
                    // Wait for socket to be ready to request code
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    try {
                        const code = await sock.requestPairingCode(cleanPhone);
                        console.log(`Real pairing code received: ${code}`);
                        if (!res.headersSent) {
                            return res.json({ code });
                        }
                    } catch (err: any) {
                        console.error('Pairing code request failed:', err.message);
                        if (!res.headersSent) {
                            return res.status(500).json({ error: `Erreur Baileys: ${err.message}. Réessayez.` });
                        }
                    }
                } else {
                    console.log(`Phone ${cleanPhone} is already registered.`);
                    if (!res.headersSent) {
                        return res.json({ message: 'Déjà enregistré' });
                    }
                }
            }
        } catch (err: any) {
            console.error(`Error in connectToWhatsApp for ${cleanPhone}:`, err);
            if (res && !res.headersSent) {
                res.status(500).json({ error: `Erreur de connexion: ${err.message}` });
            }
        } finally {
            connecting.delete(cleanPhone);
        }
    }

    app.get('/api/pairing-code', async (req, res) => {
        const phoneNumber = req.query.phone as string;
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }
        await connectToWhatsApp(phoneNumber, res);
    });

    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, '0.0.0.0', async () => {
        console.log(`Server running on http://localhost:${PORT}`);
        
        // Auto-reconnect existing sessions on startup
        const sessionsDir = path.join(process.cwd(), 'sessions');
        if (fs.existsSync(sessionsDir)) {
            const folders = fs.readdirSync(sessionsDir);
            for (const folder of folders) {
                if (folder.startsWith('session_')) {
                    const phoneNumber = folder.replace('session_', '');
                    console.log(`Restoring session for ${phoneNumber}...`);
                    try {
                        await connectToWhatsApp(phoneNumber);
                    } catch (err) {
                        console.error(`Failed to restore session for ${phoneNumber}:`, err);
                    }
                }
            }
        }
    });
}

startServer();
