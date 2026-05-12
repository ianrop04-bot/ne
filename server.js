const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store bot connection

let isConnected = false;
let pairingCode = null;

// Generate session ID
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

// ==================== WHATSAPP CONNECTION ====================
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    let sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Test Bot')
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code received');
            pairingCode = qr;
        }
        
        if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
            isConnected = true;
            pairingCode = null;
        }
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                connectWhatsApp();
            } else {
                console.log('❌ Logged out');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';
        
        console.log(`📩 From ${sender.split('@')[0]}: ${text}`);
        
        // Test commands
        if (text.toLowerCase() === '/ping') {
            await sock.sendMessage(sender, { text: '🏓 Pong! Bot is working!' });
        }
        else if (text.toLowerCase() === '/session') {
            const sessionId = generateSessionId();
            await sock.sendMessage(sender, { text: `🎫 Session ID: ${sessionId}` });
        }
        else if (text.toLowerCase() === '/help') {
            await sock.sendMessage(sender, { 
                text: `🤖 *Test Bot Commands*\n\n/ping - Check if bot is alive\n/session - Get a session ID\n/help - Show this menu` 
            });
        }
    });
}

// ==================== PAGES ====================

// Homepage
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Test Bot</title>
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{
                background:linear-gradient(135deg,#075e54,#128c7e);
                font-family:'Segoe UI',sans-serif;
                min-height:100vh;
                display:flex;
                align-items:center;
                justify-content:center;
                padding:1rem;
            }
            .card{
                background:white;
                border-radius:1.5rem;
                padding:2rem;
                width:100%;
                max-width:480px;
                text-align:center;
                box-shadow:0 20px 40px rgba(0,0,0,0.3);
            }
            .status{font-size:1.2rem;font-weight:600;margin:1rem 0;padding:0.8rem;border-radius:0.8rem}
            .online{background:#dcf8c6;color:#075e54}
            .offline{background:#fee2e2;color:#dc2626}
            .btn{
                display:inline-block;
                padding:0.8rem 1.5rem;
                margin:0.3rem;
                border:none;
                border-radius:2rem;
                font-size:0.9rem;
                cursor:pointer;
                text-decoration:none;
                color:white;
                font-weight:600;
            }
            .btn-green{background:#25d366}
            .btn-blue{background:#3b82f6}
            input{
                width:100%;
                padding:0.8rem;
                margin:0.5rem 0;
                border:2px solid #e2e8f0;
                border-radius:0.6rem;
                font-size:0.9rem;
                outline:none;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>🤖 WhatsApp Test Bot</h1>
            <div class="status ${isConnected ? 'online' : 'offline'}" id="statusBox">
                ${isConnected ? '🟢 Bot Online' : '🔴 Bot Offline'}
            </div>
            
            <a href="/qr" class="btn btn-green">📱 View QR Code</a>
            <a href="/status" class="btn btn-blue">🔄 Check Status</a>
            
            <hr style="margin:1rem 0;border-color:#e2e8f0">
            
            <h3>📤 Send Test Message</h3>
            <input type="text" id="phoneInput" placeholder="Phone number (254XXXXXXXXX)">
            <input type="text" id="msgInput" placeholder="Message text">
            <button class="btn btn-green" onclick="sendMessage()">Send Message</button>
            <p id="sendResult" style="margin-top:0.5rem;font-size:0.9rem"></p>
        </div>
        
        <script>
            async function checkStatus() {
                try {
                    const res = await fetch('/status');
                    const data = await res.json();
                    document.getElementById('statusBox').textContent = 
                        data.connected ? '🟢 Bot Online' : '🔴 Bot Offline';
                    document.getElementById('statusBox').className = 
                        'status ' + (data.connected ? 'online' : 'offline');
                } catch(e) {}
            }
            
            async function sendMessage() {
                const phone = document.getElementById('phoneInput').value.trim();
                const message = document.getElementById('msgInput').value.trim();
                const result = document.getElementById('sendResult');
                
                if(!phone || !message) return result.textContent = 'Fill all fields';
                
                try {
                    const res = await fetch('/send', {
                        method:'POST',
                        headers:{'Content-Type':'application/json'},
                        body:JSON.stringify({phone, message})
                    });
                    const data = await res.json();
                    result.textContent = data.success ? '✅ Sent!' : '❌ '+data.error;
                } catch(e) {
                    result.textContent = 'Error: '+e.message;
                }
            }
            
            checkStatus();
            setInterval(checkStatus, 10000);
        </script>
    </body>
    </html>
    `);
});

// QR Code page
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><head><title>Connected</title>
            <style>body{font-family:sans-serif;text-align:center;padding:3rem}</style>
            </head><body><h1>✅ Already Connected!</h1><a href="/">← Back</a></body></html>
        `);
    }
    
    res.send(`
        <html>
        <head>
            <title>Scan QR</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body{font-family:sans-serif;text-align:center;padding:2rem;background:#075e54;color:white}
                .card{background:white;color:#075e54;padding:2rem;border-radius:1rem;max-width:400px;margin:2rem auto}
                .btn{background:#25d366;color:white;padding:0.8rem 1.5rem;border-radius:2rem;text-decoration:none;font-weight:600}
            </style>
        </head>
        <body>
            <div class="card">
                <h1>📱 Scan QR Code</h1>
                <p>Check your Render logs for the QR code.</p>
                <p>OR use pairing code method below.</p>
                <a href="/pair" class="btn">Use Phone Number Instead</a>
                <br><br>
                <a href="/">← Back</a>
            </div>
        </body>
        </html>
    `);
});

// Pairing code page
app.get('/pair', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Pairing Code</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body{font-family:sans-serif;text-align:center;padding:2rem;background:#075e54;color:white}
                .card{background:white;color:#075e54;padding:2rem;border-radius:1rem;max-width:400px;margin:2rem auto}
                input{padding:0.8rem;width:100%;border-radius:0.5rem;border:2px solid #e2e8f0;font-size:1rem;margin:0.5rem 0}
                .btn{background:#25d366;color:white;padding:0.8rem 1.5rem;border:1px solid #075e54;border-radius:2rem;font-weight:600;cursor:pointer;width:100%}
            </style>
        </head>
        <body>
            <div class="card">
                <h1>📱 Pairing Code</h1>
                <p>Enter your WhatsApp number to get a pairing code</p>
                <input type="text" id="phoneInput" placeholder="254XXXXXXXXX">
                <button class="btn" onclick="getPairingCode()">Get Code</button>
                <p id="result" style="margin-top:1rem"></p>
                <br>
                <a href="/" style="color:#075e54">← Back</a>
            </div>
        </body>
        <script>
            async function getPairingCode() {
                const phone = document.getElementById('phoneInput').value.trim();
                if(!phone) return;
                
                try {
                    const res = await fetch('/request-pair?phone=' + phone);
                    const data = await res.json();
                    document.getElementById('result').textContent = 
                        data.code ? 'Code: ' + data.code : 'Error: ' + data.error;
                } catch(e) {
                    document.getElementById('result').textContent = 'Error: ' + e.message;
                }
            }
        </script>
        </html>
    `);
});

// ==================== API ENDPOINTS ====================

// Status check
app.get('/status', (req, res) => {
    res.json({ 
        connected: isConnected,
        botNumber: sock?.user?.id?.split('@')[0] || null
    });
});

// Send message
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.json({ success: false, error: 'Phone and message required' });
    }
    
    if (!isConnected || !sock) {
        return res.json({ success: false, error: 'Bot not connected' });
    }
    
    try {
        const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Request pairing code
app.get('/request-pair', async (req, res) => {
    const { phone } = req.query;
    
    if (!phone) {
        return res.json({ error: 'Phone number required' });
    }
    
    if (isConnected) {
        return res.json({ error: 'Already connected' });
    }
    
    try {
        const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
        console.log('Pairing code:', code);
        res.json({ code });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Generate session
app.get('/generate-session', (req, res) => {
    const sessionId = generateSessionId();
    res.json({ success: true, sessionId });
});

// Health check (for Render keep-alive) [citation:1]
app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected });
});

// ==================== START ====================
const PORT = process.env.PORT || 3230;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    connectWhatsApp();
});
