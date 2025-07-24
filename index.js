require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');

// --- 1. Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

// --- 2. WhatsApp & Bot Configuration ---
let sock;
const API_KEY = process.env.API_KEY;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const KEYWORDS = ['#prayer', '#prayer request'];

// --- 3. Baileys Connection Logic ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // printQRInTerminal: true, // <-- This option is removed as it's deprecated
    });

    sock.ev.on('messages.upsert', m => {
        const msg = m.messages[0];
        if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
            console.log(`\n--- GROUP MESSAGE RECEIVED ---`);
            console.log(`Group ID: ${msg.key.remoteJid}`);
            console.log(`--------------------------\n`);
        }
    });

    // ✅ THIS SECTION IS UPDATED TO MANUALLY PRINT THE QR CODE
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('------------------------------------------------');
            console.log('SCAN THE QR CODE BELOW');
            qrcode.generate(qr, { small: true });
            console.log('------------------------------------------------');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened!');
            if (!WHATSAPP_GROUP_ID) {
                console.log('\n🚨 WARNING: WHATSAPP_GROUP_ID is not set in your environment.');
                console.log('To find the ID, send a message to your target group and look for the log above.');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- 4. Webhook Endpoint ---
app.post('/incoming', async (req, res) => {
    // ... (This section remains the same) ...
    console.log('Received request on /incoming:', req.body);

    const providedApiKey = req.headers['x-api-key'];
    if (!API_KEY || providedApiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sock || !WHATSAPP_GROUP_ID) {
        return res.status(503).json({ error: 'WhatsApp client not ready or Group ID not configured' });
    }

    const { text, user } = req.body;
    if (!text || !user) {
        return res.status(400).json({ error: 'Missing text or user field' });
    }

    const found = KEYWORDS.find(k => text.toLowerCase().includes(k.toLowerCase()));
    if (!found) {
        return res.status(200).json({ message: 'No keyword match' });
    }

    const alertMsg = `🚨 *${found.toUpperCase()}* from ${user}:\n\n${text}`;

    try {
        await sock.sendMessage(WHATSAPP_GROUP_ID, { text: alertMsg });
        console.log(`Alert sent to group ${WHATSAPP_GROUP_ID}`);
        res.json({ message: 'Alert sent' });
    } catch (err) {
        console.error('WhatsApp send error:', err);
        res.status(500).json({ error: 'Failed to send alert' });
    }
});

// --- 5. Start Everything ---
if (!API_KEY) {
    console.error('FATAL ERROR: API_KEY environment variable is required.');
    process.exit(1);
}

connectToWhatsApp();
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${process.env.PORT || 3000}`));