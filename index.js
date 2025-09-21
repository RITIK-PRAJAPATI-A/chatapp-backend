require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

// --- 1. Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

// Reads allowed origins from environment variables
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || 'http://localhost:5173';
const allowedOrigins = allowedOriginsEnv.split(',').map(origin => origin.trim());

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json());


// --- 2. WhatsApp & Bot Configuration ---
let sock;
let qrCodeData = null; // Variable to store the QR code
let connectionStatus = 'connecting'; // Variable to track connection status

const API_KEY = process.env.API_KEY;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const KEYWORDS = ['#prayer', '#prayer_request', '#prayer_points', '@prayer', '@prayer_request', '@prayer_points'];

// --- 3. Baileys Connection Logic ---
async function connectToWhatsApp() {
    console.log('🔌 Starting WhatsApp connection...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false // We handle QR code display manually
    });

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR code received, accessible at /qr endpoint.');
            qrCodeData = qr;
            connectionStatus = 'qr';
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            connectionStatus = 'closed';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            // ✅ THIS IS WHERE THE METADATA IS LOGGED
            console.log('✅ WhatsApp connection opened!');
            console.log(`📲 Logged in as: ${sock.user.name} (${sock.user.id})`);
            qrCodeData = null; // Clear QR code once connected
            connectionStatus = 'open';
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- 4. API Endpoints ---

// Health Check Endpoint for Uptime Robot
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        message: `Bot status: ${connectionStatus}`
    });
});

// QR Code Display Endpoint
app.get('/qr', async (req, res) => {
    if (qrCodeData) {
        try {
            const qrImage = await qrcode.toDataURL(qrCodeData);
            res.send(`<img src="${qrImage}" alt="Scan this QR code with WhatsApp" />`);
        } catch (err) {
            res.status(500).json({ error: 'Failed to generate QR code image.' });
        }
    } else {
        res.status(200).json({ message: 'No QR code available. Bot might be connected or still initializing.' });
    }
});

// Webhook Endpoint to send messages
app.post('/incoming', async (req, res) => {
    console.log('Received request on /incoming:', req.body);
    const providedApiKey = req.headers['x-api-key'];

    if (!API_KEY || providedApiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (connectionStatus !== 'open' || !sock || !WHATSAPP_GROUP_ID) {
        return res.status(503).json({ error: 'WhatsApp client not ready or Group ID not configured' });
    }

    const { text, user } = req.body;
    if (!text || !user) {
        return res.status(400).json({ error: 'Missing text or user field' });
    }

    const found = KEYWORDS.find(k => text.toLowerCase().includes(k.toLowerCase()));
    if (!found) {
        return res.status(200).json({ message: 'No keyword match, message ignored.' });
    }

    const alertMsg = `${text}`; // Message format
    try {
        await sock.sendMessage(WHATSAPP_GROUP_ID, { text: alertMsg });
        console.log(`✅ Alert sent to group ${WHATSAPP_GROUP_ID}`);
        res.json({ message: 'Alert sent successfully' });
    } catch (err) {
        console.error('❌ WhatsApp send error:', err);
        res.status(500).json({ error: 'Failed to send alert' });
    }
});


// --- 5. Start Everything ---
if (!API_KEY) {
    console.error('FATAL ERROR: API_KEY environment variable is required.');
    process.exit(1);
}

// Start the WhatsApp connection first
connectToWhatsApp();
// Then start the web server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));