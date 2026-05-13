const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');

const app = express();

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== SESSION STORE ====================
const sessions = new Map();

if (!fs.existsSync('./sessions')) {
    fs.mkdirSync('./sessions');
}

// ==================== SESSION MANAGER ====================
class SessionManager {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sock = null;
        this.connected = false;
        this.qrCode = null;
        this.botNumber = null;
        this.createdAt = new Date();
    }

    async start() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(`sessions/${this.sessionId}`);

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04']
            });

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qrCode = qr;
                }

                if (connection === 'open') {
                    console.log(`✅ Session ${this.sessionId} connected!`);
                    this.connected = true;
                    this.qrCode = null;
                    this.botNumber = this.sock.user?.id?.split('@')[0] || null;
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                        && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

                    if (shouldReconnect) {
                        console.log(`🔄 Session ${this.sessionId} reconnecting...`);
                        setTimeout(() => this.start(), 5000);
                    } else {
                        console.log(`❌ Session ${this.sessionId} logged out`);
                        this.connected = false;
                        this.qrCode = null;
                        sessions.delete(this.sessionId);
                        try { fs.rmSync(`sessions/${this.sessionId}`, { recursive: true, force: true }); } catch(e) {}
                    }
                }
            });

            this.sock.ev.on('messages.upsert', async ({ messages }) => {
                const msg = messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const sender = msg.key.remoteJid;
                const text = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || '';

                console.log(`📩 [${this.sessionId}] ${sender.split('@')[0]}: ${text}`);

                if (text.toLowerCase() === '/ping') {
                    await this.sock.sendMessage(sender, { text: '🏓 Pong! Bot is working!' });
                }
                else if (text.toLowerCase() === '/help') {
                    await this.sock.sendMessage(sender, { 
                        text: `🤖 *NEXFGEN HUB*\n\n/ping - Check bot\n/info - Bot info\n/help - Commands` 
                    });
                }
                else if (text.toLowerCase() === '/info') {
                    await this.sock.sendMessage(sender, { 
                        text: `🤖 *Bot Info*\n\nSession: ${this.sessionId}\nConnected: ${this.connected ? '✅' : '❌'}` 
                    });
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

        } catch (error) {
            console.error(`Error session ${this.sessionId}:`, error);
        }
    }

    async sendMessage(jid, message) {
        try {
            await this.sock.sendMessage(jid, { text: message });
            return true;
        } catch (error) {
            return false;
        }
    }

    async requestPairingCode(phoneNumber) {
        return await this.sock.requestPairingCode(phoneNumber);
    }

    disconnect() {
        try {
            this.sock?.end();
            sessions.delete(this.sessionId);
            fs.rmSync(`sessions/${this.sessionId}`, { recursive: true, force: true });
        } catch(e) {}
    }
}

// ==================== API ROUTES ====================

app.post('/api/create-session', async (req, res) => {
    const sessionId = 'NEX' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
    
    try {
        const session = new SessionManager(sessionId);
        await session.start();
        sessions.set(sessionId, session);
        res.json({ success: true, sessionId });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/qr/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    
    if (!session) return res.json({ success: false, error: 'Session not found' });
    if (session.connected) return res.json({ success: true, connected: true, qr: null });
    if (session.qrCode) {
        try {
            const qrImage = await QRCode.toDataURL(session.qrCode);
            return res.json({ success: true, connected: false, qr: qrImage });
        } catch(e) {
            return res.json({ success: false, error: 'QR generation failed' });
        }
    }
    res.json({ success: true, connected: false, qr: null });
});

app.get('/api/pair/:sessionId', async (req, res) => {
    const { phone } = req.query;
    const session = sessions.get(req.params.sessionId);

    if (!session) return res.json({ success: false, error: 'Session not found' });
    if (!phone) return res.json({ success: false, error: 'Phone required' });

    try {
        const code = await session.requestPairingCode(phone.replace(/[^0-9]/g, ''));
        res.json({ success: true, code });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.json({ success: false, connected: false });
    
    res.json({
        success: true,
        connected: session.connected,
        botNumber: session.botNumber
    });
});

app.post('/api/send/:sessionId', async (req, res) => {
    const { phone, message } = req.body;
    const session = sessions.get(req.params.sessionId);

    if (!session) return res.json({ success: false, error: 'Session not found' });
    if (!session.connected) return res.json({ success: false, error: 'Not connected' });
    if (!phone || !message) return res.json({ success: false, error: 'Phone and message required' });

    try {
        const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const sent = await session.sendMessage(jid, message);
        res.json({ success: sent });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.delete('/api/session/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.json({ success: false });
    
    session.disconnect();
    res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
    const list = [];
    sessions.forEach((s, id) => {
        list.push({
            sessionId: id,
            connected: s.connected,
            botNumber: s.botNumber
        });
    });
    res.json({ success: true, sessions: list });
});

// ==================== MAIN PAGE ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>『𝐍𝐄𝐗𝐅𝐆𝐄𝐍』◆『𝐇𝐔𝐁』</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;700&display=swap');
        *{margin:0;padding:0;box-sizing:border-box}
        body{
            background:#0a0a0a;
            font-family:'Rajdhani',sans-serif;
            min-height:100vh;
            color:#fff;
            overflow-x:hidden;
        }
        body::before{
            content:'';
            position:fixed;
            top:0;left:0;
            width:100%;height:100%;
            background:radial-gradient(ellipse at 20% 50%,rgba(0,255,136,0.03) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(0,255,255,0.03) 0%,transparent 50%);
            z-index:0;
            pointer-events:none;
        }
        .app{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:1rem}
        .header{text-align:center;padding:2rem 0}
        .logo-main{
            font-family:'Orbitron',sans-serif;
            font-size:1.5rem;font-weight:900;
            background:linear-gradient(135deg,#00ff88,#00ffff);
            -webkit-background-clip:text;
            -webkit-text-fill-color:transparent;
            text-shadow:0 0 30px rgba(0,255,136,0.5);
            letter-spacing:2px;
            margin-bottom:0.3rem;
        }
        .logo-sub{font-family:'Orbitron',sans-serif;font-size:0.8rem;color:rgba(255,255,255,0.5);letter-spacing:4px}
        .create-section{text-align:center;margin-bottom:2rem}
        .btn-create{
            padding:1rem 2.5rem;
            background:linear-gradient(135deg,#00ff88,#00cc6a);
            color:#0a0a0a;
            border:none;
            border-radius:12px;
            font-family:'Rajdhani',sans-serif;
            font-size:1.2rem;font-weight:700;
            letter-spacing:2px;
            cursor:pointer;
            box-shadow:0 0 30px rgba(0,255,136,0.3);
            transition:all 0.3s ease;
        }
        .btn-create:hover{box-shadow:0 0 50px rgba(0,255,136,0.6);transform:translateY(-2px)}
        .sessions-grid{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fill,minmax(350px,1fr))}
        .session-card{
            background:rgba(15,15,20,0.95);
            border:1px solid rgba(0,255,136,0.15);
            border-radius:16px;
            padding:1.5rem;
            box-shadow:0 0 20px rgba(0,255,136,0.05);
            transition:all 0.3s ease;
        }
        .session-card:hover{border-color:rgba(0,255,136,0.3);box-shadow:0 0 30px rgba(0,255,136,0.1)}
        .session-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
        .session-id{font-family:'Orbitron',monospace;font-size:0.8rem;color:rgba(255,255,255,0.6);letter-spacing:1px}
        .status-dot{width:12px;height:12px;border-radius:50%;display:inline-block}
        .online{background:#00ff88;box-shadow:0 0 10px rgba(0,255,136,0.5);animation:pulse 2s infinite}
        .offline{background:#ff0055;box-shadow:0 0 10px rgba(255,0,85,0.5)}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        .qr-section{text-align:center;padding:1rem 0}
        .qr-image{max-width:200px;border-radius:10px;border:1px solid rgba(0,255,136,0.2)}
        .pairing-section{margin-top:1rem}
        .input-group{display:flex;gap:0.5rem;margin-bottom:0.5rem}
        input{
            flex:1;
            padding:0.7rem;
            background:rgba(255,255,255,0.03);
            border:1px solid rgba(0,255,136,0.2);
            border-radius:8px;
            color:#fff;
            font-family:'Rajdhani',sans-serif;
            font-size:0.9rem;
            outline:none;
            transition:all 0.3s ease;
        }
        input:focus{border-color:#00ff88;box-shadow:0 0 15px rgba(0,255,136,0.2)}
        input::placeholder{color:rgba(255,255,255,0.2)}
        .btn-small{
            padding:0.7rem 1rem;
            background:linear-gradient(135deg,#00ffff,#00b3ff);
            color:#0a0a0a;
            border:none;
            border-radius:8px;
            font-family:'Rajdhani',sans-serif;
            font-weight:700;font-size:0.8rem;
            letter-spacing:1px;
            cursor:pointer;
            white-space:nowrap;
            transition:all 0.3s ease;
        }
        .btn-small:hover{box-shadow:0 0 20px rgba(0,255,255,0.4)}
        .btn-danger{
            background:rgba(255,0,85,0.2);
            color:#ff0055;
            border:1px solid rgba(255,0,85,0.3);
            margin-top:0.5rem;
            width:100%;
            padding:0.5rem;
            border-radius:8px;
            font-family:'Rajdhani',sans-serif;
            font-weight:700;
            cursor:pointer;
            transition:all 0.3s ease;
        }
        .btn-danger:hover{background:rgba(255,0,85,0.3);box-shadow:0 0 20px rgba(255,0,85,0.2)}
        .code-display{
            background:rgba(0,0,0,0.5);
            border:2px dashed rgba(0,255,136,0.3);
            border-radius:10px;
            padding:1rem;
            text-align:center;
            margin:0.5rem 0;
        }
        .code-text{
            font-family:'Orbitron',monospace;
            font-size:1.5rem;font-weight:900;
            letter-spacing:0.3rem;
            background:linear-gradient(135deg,#00ff88,#00ffff);
            -webkit-background-clip:text;
            -webkit-text-fill-color:transparent;
        }
        .info-text{color:rgba(255,255,255,0.4);font-size:0.8rem;text-align:center;margin-top:0.5rem}
        .message-section{margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(255,255,255,0.05)}
        .result-msg{text-align:center;font-size:0.8rem;margin-top:0.5rem}
        @media(max-width:768px){.sessions-grid{grid-template-columns:1fr}.logo-main{font-size:1.2rem}}
    </style>
</head>
<body>
    <div class="app">
        <div class="header">
            <div class="logo-main">『𝐍𝐄𝐗𝐅𝐆𝐄𝐍』</div>
            <div class="logo-sub">◆『𝐇𝐔𝐁』◆ MULTI-DEVICE</div>
        </div>
        <div class="create-section">
            <button class="btn-create" onclick="createSession()">⚡ CREATE NEW SESSION</button>
        </div>
        <div class="sessions-grid" id="sessionsGrid"></div>
    </div>
    <script>
        const API = window.location.origin;
        const sessions = new Map();
        checkAllSessions();
        setInterval(checkAllSessions, 5000);
        async function createSession(){
            try{
                const r=await fetch(API+'/api/create-session',{method:'POST'});
                const d=await r.json();
                if(d.success)addSessionCard(d.sessionId);
            }catch(e){}
        }
        function addSessionCard(sid){
            if(sessions.has(sid))return;
            const c=document.createElement('div');
            c.className='session-card';
            c.id='card-'+sid;
            c.innerHTML=\`
                <div class="session-header">
                    <span class="session-id">\${sid}</span>
                    <span class="status-dot offline" id="dot-\${sid}"></span>
                </div>
                <div class="qr-section" id="qr-\${sid}"><p class="info-text">⏳ Waiting for QR...</p></div>
                <div class="pairing-section">
                    <p style="text-align:center;font-size:0.8rem;color:rgba(255,255,255,0.4);margin-bottom:0.5rem;">OR PAIRING CODE</p>
                    <div class="input-group">
                        <input id="phone-\${sid}" placeholder="254XXXXXXXXX">
                        <button class="btn-small" onclick="getPair('\${sid}')">GET CODE</button>
                    </div>
                    <div id="pair-\${sid}"></div>
                </div>
                <div class="message-section">
                    <p style="text-align:center;font-size:0.8rem;color:rgba(255,255,255,0.4);margin-bottom:0.5rem;">SEND MESSAGE</p>
                    <div class="input-group"><input id="to-\${sid}" placeholder="Recipient"></div>
                    <div class="input-group">
                        <input id="msg-\${sid}" placeholder="Message">
                        <button class="btn-small" onclick="sendMsg('\${sid}')">SEND</button>
                    </div>
                    <div id="sres-\${sid}" class="result-msg"></div>
                </div>
                <button class="btn-danger" onclick="disconnect('\${sid}')">⚠ DISCONNECT</button>
            \`;
            document.getElementById('sessionsGrid').appendChild(c);
            sessions.set(sid,{connected:false});
            checkSession(sid);
            setInterval(()=>checkSession(sid),3000);
        }
        async function checkAllSessions(){
            try{
                const r=await fetch(API+'/api/sessions');
                const d=await r.json();
                if(d.success&&d.sessions)d.sessions.forEach(s=>{if(!sessions.has(s.sessionId))addSessionCard(s.sessionId)});
            }catch(e){}
        }
        async function checkSession(sid){
            try{
                const r=await fetch(API+'/api/status/'+sid);
                const d=await r.json();
                const dot=document.getElementById('dot-'+sid);
                const qrD=document.getElementById('qr-'+sid);
                if(d.connected){
                    if(dot){dot.className='status-dot online'}
                    if(qrD)qrD.innerHTML='<p style="color:#00ff88;">✅ Connected as '+(d.botNumber||'Unknown')+'</p>';
                    sessions.set(sid,{connected:true});
                }else{
                    if(dot)dot.className='status-dot offline';
                    const q=await fetch(API+'/api/qr/'+sid);
                    const qd=await q.json();
                    if(qd.qr&&qrD)qrD.innerHTML='<p style="margin-bottom:0.5rem;font-size:0.8rem;">Scan with WhatsApp:</p><img src="'+qd.qr+'" class="qr-image">';
                    sessions.set(sid,{connected:false});
                }
            }catch(e){}
        }
        async function getPair(sid){
            const p=document.getElementById('phone-'+sid).value.trim();
            const r=document.getElementById('pair-'+sid);
            if(!p){r.innerHTML='<p style="color:#ff0055;">Enter phone</p>';return}
            try{
                const res=await fetch(API+'/api/pair/'+sid+'?phone='+p);
                const d=await res.json();
                if(d.success&&d.code)r.innerHTML='<div class="code-display"><div class="code-text">'+d.code+'</div></div><p style="color:#00ff88;text-align:center;font-size:0.8rem;">Enter in WhatsApp</p>';
                else r.innerHTML='<p style="color:#ff0055;">'+(d.error||'Failed')+'</p>';
            }catch(e){r.innerHTML='<p style="color:#ff0055;">Error</p>'}
        }
        async function sendMsg(sid){
            const t=document.getElementById('to-'+sid).value.trim();
            const m=document.getElementById('msg-'+sid).value.trim();
            const r=document.getElementById('sres-'+sid);
            if(!t||!m){r.innerHTML='<p style="color:#ff0055;">Fill all</p>';return}
            try{
                const res=await fetch(API+'/api/send/'+sid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:t,message:m})});
                const d=await res.json();
                if(d.success){r.innerHTML='<p style="color:#00ff88;">✅ Sent!</p>';document.getElementById('msg-'+sid).value=''}
                else r.innerHTML='<p style="color:#ff0055;">❌ '+(d.error||'Failed')+'</p>';
            }catch(e){r.innerHTML='<p style="color:#ff0055;">Error</p>'}
        }
        async function disconnect(sid){
            try{
                await fetch(API+'/api/session/'+sid,{method:'DELETE'});
                document.getElementById('card-'+sid)?.remove();
                sessions.delete(sid);
            }catch(e){}
        }
    </script>
</body>
</html>`);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size });
});

